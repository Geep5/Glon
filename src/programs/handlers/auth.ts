// Auth — manage credentials for external LLM providers.
//
// First and only provider today: Anthropic via Claude Pro/Max. The OAuth
// flow mimics the Claude Code CLI — we redirect the user to claude.ai,
// catch the redirect on a local HTTP server, exchange the PKCE code for
// a Bearer token, and persist it. Subsequent requests authenticate as
// "Claude Code" so traffic bills against the user's Pro/Max subscription
// rather than API credits.
//
// Storage is intentionally NOT in the DAG. Credentials expire and rotate;
// committing every refresh to an append-only log is wasteful, leaks tokens
// to peers when objects sync, and makes "logout" impossible. They live in
// a flat JSON file under GLON_DATA, mode 0600, written atomically.
//
// Other programs (currently /agent, in the future anything else that wants
// to talk to Anthropic) consume credentials via the actor RPC:
//   ctx.dispatchProgram("/auth", "getAnthropic", [])
// which returns { token, isOAuth } with on-demand refresh, or null when
// no credentials are configured. The caller is expected to fall back to
// ANTHROPIC_API_KEY (or fail) on null.
//
// Coupling notes:
//   - All HTTP/file/crypto use `node:` builtins. The program runtime's
//     bundler only resolves bare requires for kernel modules, so this
//     file MUST avoid importing from outside `runtime.js` types and
//     `node:*` modules. Any helper used here lives in this file.
//   - Anthropic's OAuth client_id is the public Claude Code one. If
//     Anthropic ever introduces server-side allowlisting we'll get
//     bounced — there is no Glon-specific client to register against.
//   - The "Claude Code" version number, beta strings, and X-Stainless
//     headers are part of the impersonation. They drift over time as the
//     official CLI updates. Bump them in agent.ts when requests start
//     failing with 4xx; this file owns the auth flow only.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }

// ── Anthropic OAuth constants ────────────────────────────────────
//
// Sourced from the Claude Code CLI. The client_id is the public app id
// the official `claude` binary uses; we obfuscate it at rest only to
// avoid drive-by scrapers, not as security.

const ANTHROPIC_CLIENT_ID = Buffer.from(
	"OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl",
	"base64",
).toString("utf-8");
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CALLBACK_PORT = 54545;
const ANTHROPIC_CALLBACK_PATH = "/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

// Refresh tokens once we're within this many ms of expiry.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Hard cap on the OAuth login interactive flow.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ── File layout ──────────────────────────────────────────────────

interface AnthropicOAuthCredential {
	type: "oauth";
	access: string;
	refresh: string;
	/** Unix ms when the access token stops being accepted. */
	expires: number;
}

interface AnthropicApiKeyCredential {
	type: "api_key";
	key: string;
}

type AnthropicCredential = AnthropicOAuthCredential | AnthropicApiKeyCredential;

interface AuthFile {
	version: 1;
	credentials: {
		anthropic?: AnthropicCredential;
	};
}

function authFilePath(): string {
	const root = process.env.GLON_DATA ?? join(homedir(), ".glon");
	return join(root, "auth.json");
}

function readAuthFile(): AuthFile {
	const path = authFilePath();
	if (!existsSync(path)) {
		return { version: 1, credentials: {} };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && parsed.version === 1) {
			return {
				version: 1,
				credentials: (parsed.credentials && typeof parsed.credentials === "object") ? parsed.credentials : {},
			};
		}
	} catch {
		// Corrupt file — treat as empty so logging in resets it.
	}
	return { version: 1, credentials: {} };
}

/**
 * Atomic write: stage to .tmp, chmod 0600, rename. POSIX rename is atomic
 * within a filesystem, so concurrent readers either see the old or new
 * content but never a partial write.
 */
function writeAuthFile(file: AuthFile): void {
	const path = authFilePath();
	const dir = path.slice(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
	try { chmodSync(tmp, 0o600); } catch { /* best-effort on non-POSIX */ }
	renameSync(tmp, path);
}

function deleteAuthFile(): void {
	const path = authFilePath();
	try { unlinkSync(path); } catch { /* missing is fine */ }
}

// ── PKCE helpers ─────────────────────────────────────────────────

/** RFC 7636 base64url: standard base64 with URL-safe alphabet, no padding. */
function base64UrlEncode(bytes: Buffer): string {
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Pkce {
	verifier: string;
	challenge: string;
}

function generatePkce(): Pkce {
	const verifier = base64UrlEncode(randomBytes(32));
	const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

// ── Local callback server ───────────────────────────────────────

interface CallbackResult {
	code: string;
	state: string;
}

/**
 * Start an HTTP server on `ANTHROPIC_CALLBACK_PORT` that resolves with the
 * first request to `ANTHROPIC_CALLBACK_PATH` carrying a `code` query param.
 * Anything else gets a 404 so a stray browser visit doesn't poison the flow.
 */
function startCallbackServer(): { promise: Promise<CallbackResult>; close: () => void } {
	let server: Server | null = null;
	let resolve!: (r: CallbackResult) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<CallbackResult>((res, rej) => { resolve = res; reject = rej; });

	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", `http://localhost:${ANTHROPIC_CALLBACK_PORT}`);
			if (url.pathname !== ANTHROPIC_CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") ?? "";
			const error = url.searchParams.get("error");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`<!doctype html><meta charset="utf-8"><title>Glon auth — error</title>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:4em auto;padding:0 1em;">
<h2>Authorization failed</h2>
<p>${escapeHtml(error)}</p>
<p>Close this tab and re-run <code>/auth login anthropic</code>.</p>
</body>`);
				reject(new Error(`OAuth error: ${error}`));
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Missing code");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><meta charset="utf-8"><title>Glon auth — done</title>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:4em auto;padding:0 1em;">
<h2>You're signed in.</h2>
<p>You can close this tab and return to your terminal.</p>
</body>`);
			resolve({ code, state });
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});

	server.on("error", (err) => reject(err));
	server.listen(ANTHROPIC_CALLBACK_PORT, "127.0.0.1");

	return {
		promise,
		close: () => { try { server?.close(); } catch { /* best-effort */ } },
	};
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === "&" ? "&amp;" :
		c === "<" ? "&lt;" :
		c === ">" ? "&gt;" :
		c === '"' ? "&quot;" : "&#39;"
	);
}

// ── Anthropic OAuth flow ─────────────────────────────────────────

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

async function exchangeAnthropicCode(args: {
	code: string;
	state: string;
	verifier: string;
	redirectUri: string;
}): Promise<AnthropicOAuthCredential> {
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: ANTHROPIC_CLIENT_ID,
			code: args.code,
			state: args.state,
			redirect_uri: args.redirectUri,
			code_verifier: args.verifier,
		}),
	});
	if (!res.ok) {
		const body = await safeText(res);
		throw new Error(`Anthropic token exchange failed: HTTP ${res.status} ${body}`);
	}
	const data = await res.json() as TokenResponse;
	// 5-minute safety buffer matches the refresh check below.
	const expires = Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS;
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires,
	};
}

export async function refreshAnthropicToken(refreshToken: string): Promise<AnthropicOAuthCredential> {
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: ANTHROPIC_CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});
	if (!res.ok) {
		const body = await safeText(res);
		throw new Error(`Anthropic token refresh failed: HTTP ${res.status} ${body}`);
	}
	const data = await res.json() as TokenResponse;
	const expires = Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS;
	return {
		type: "oauth",
		access: data.access_token,
		// Anthropic rotates refresh tokens; if a new one is missing, keep the old one.
		refresh: data.refresh_token || refreshToken,
		expires,
	};
}

async function safeText(res: Response): Promise<string> {
	try { return await res.text(); } catch { return `(unreadable response body)`; }
}

interface InteractiveLogin {
	authUrl: string;
	completion: Promise<AnthropicOAuthCredential>;
	cancel: () => void;
}

/**
 * Begin the Anthropic OAuth flow. Returns immediately with the URL the
 * user must open and a promise that resolves when the callback fires.
 * The handler prints the URL synchronously so a slow `open` shell-out
 * never delays the visible prompt.
 */
function beginAnthropicLogin(): InteractiveLogin {
	const pkce = generatePkce();
	const state = base64UrlEncode(randomBytes(16));
	const redirectUri = `http://localhost:${ANTHROPIC_CALLBACK_PORT}${ANTHROPIC_CALLBACK_PATH}`;
	const params = new URLSearchParams({
		code: "true",
		client_id: ANTHROPIC_CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: ANTHROPIC_SCOPES,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state,
	});
	const authUrl = `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;

	const callback = startCallbackServer();

	const completion = (async () => {
		const timeoutMs = LOGIN_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		const timed = new Promise<never>((_, rej) => {
			timer = setTimeout(() => rej(new Error(`OAuth login timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
		});
		try {
			const result = await Promise.race([callback.promise, timed]);
			if (result.state && result.state !== state) {
				throw new Error("OAuth state mismatch — possible CSRF or stale tab");
			}
			return await exchangeAnthropicCode({
				code: result.code,
				state: result.state,
				verifier: pkce.verifier,
				redirectUri,
			});
		} finally {
			if (timer) clearTimeout(timer);
			callback.close();
		}
	})();

	return {
		authUrl,
		completion,
		cancel: () => callback.close(),
	};
}

// ── Resolver (the public read path) ──────────────────────────────

export interface ResolvedAnthropicCredential {
	token: string;
	isOAuth: boolean;
}

interface ResolverState {
	/** In-flight refresh promise; coalesces concurrent same-process refreshes. */
	refreshInflight: Promise<AnthropicOAuthCredential> | null;
}

/**
 * Read a token suitable for an Anthropic API call. If the stored credential
 * is OAuth and within REFRESH_BUFFER_MS of expiry, refresh in place and
 * persist before returning.
 *
 * Returns null when no credential is configured (the caller should fall
 * back to ANTHROPIC_API_KEY env var or surface a clear error).
 */
async function resolveAnthropic(state: ResolverState): Promise<ResolvedAnthropicCredential | null> {
	const file = readAuthFile();
	const cred = file.credentials.anthropic;
	if (!cred) return null;

	if (cred.type === "api_key") {
		return { token: cred.key, isOAuth: false };
	}

	// OAuth path. Refresh if expiring soon.
	if (cred.expires > Date.now()) {
		return { token: cred.access, isOAuth: true };
	}

	// Coalesce concurrent in-process refreshes.
	if (!state.refreshInflight) {
		state.refreshInflight = (async () => {
			try {
				const refreshed = await refreshAnthropicToken(cred.refresh);
				const updated = readAuthFile();
				updated.credentials.anthropic = refreshed;
				writeAuthFile(updated);
				return refreshed;
			} catch (err) {
				// Another instance may have already refreshed and rotated the
				// token; try one re-read before giving up so we don't surface a
				// transient race as a hard failure.
				const reread = readAuthFile().credentials.anthropic;
				if (reread && reread.type === "oauth" && reread.access !== cred.access && reread.expires > Date.now()) {
					return reread;
				}
				throw err;
			} finally {
				state.refreshInflight = null;
			}
		})();
	}
	const refreshed = await state.refreshInflight;
	return { token: refreshed.access, isOAuth: true };
}

/**
 * Force a refresh regardless of expiry. Used by `/agent` after a 401 from
 * the API: the local clock may have drifted, the buffer may have been too
 * tight, or another process rotated the refresh token.
 */
async function forceRefreshAnthropic(state: ResolverState): Promise<ResolvedAnthropicCredential | null> {
	const file = readAuthFile();
	const cred = file.credentials.anthropic;
	if (!cred || cred.type !== "oauth") return null;

	if (!state.refreshInflight) {
		state.refreshInflight = (async () => {
			try {
				const refreshed = await refreshAnthropicToken(cred.refresh);
				const updated = readAuthFile();
				updated.credentials.anthropic = refreshed;
				writeAuthFile(updated);
				return refreshed;
			} finally {
				state.refreshInflight = null;
			}
		})();
	}
	const refreshed = await state.refreshInflight;
	return { token: refreshed.access, isOAuth: true };
}

// ── Status formatting ────────────────────────────────────────────

function formatExpiry(expires: number): string {
	const ms = expires - Date.now();
	if (ms <= 0) return red("expired");
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return green(`${mins}m`);
	const hours = Math.floor(mins / 60);
	if (hours < 48) return green(`${hours}h ${mins % 60}m`);
	const days = Math.floor(hours / 24);
	return green(`${days}d ${hours % 24}h`);
}

function describeAnthropicCredential(cred: AnthropicCredential | undefined): string[] {
	const lines: string[] = [];
	if (!cred) {
		const env = process.env.ANTHROPIC_API_KEY;
		if (env) {
			lines.push(`  ${bold("anthropic")}  ${dim("api_key (env: ANTHROPIC_API_KEY)")}`);
			lines.push(dim(`    ${preview(env)}`));
		} else {
			lines.push(`  ${bold("anthropic")}  ${red("not configured")}`);
			lines.push(dim(`    Run ${cyan("/auth login anthropic")} for a Pro/Max plan,`));
			lines.push(dim(`    or set ${cyan("ANTHROPIC_API_KEY")} in .env`));
		}
		return lines;
	}
	if (cred.type === "api_key") {
		lines.push(`  ${bold("anthropic")}  ${dim("api_key (auth.json)")}`);
		lines.push(dim(`    ${preview(cred.key)}`));
		return lines;
	}
	lines.push(`  ${bold("anthropic")}  ${cyan("oauth (Claude Pro/Max)")}`);
	lines.push(dim(`    access expires in ${formatExpiry(cred.expires)}`));
	lines.push(dim(`    ${preview(cred.access)}`));
	return lines;
}

function preview(token: string): string {
	if (token.length <= 16) return token;
	return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	const state = ctx.state as ResolverState;

	switch (cmd) {
		case "login": {
			const provider = args[0] ?? "anthropic";
			if (provider !== "anthropic") {
				print(red(`Unknown provider: ${provider}`));
				print(dim(`  Supported: anthropic`));
				break;
			}
			print(dim("  Starting OAuth flow…"));
			let session: InteractiveLogin;
			try {
				session = beginAnthropicLogin();
			} catch (err: any) {
				print(red("  Could not start callback server: ") + (err?.message ?? String(err)));
				print(dim(`  Is port ${ANTHROPIC_CALLBACK_PORT} already in use?`));
				break;
			}
			print("");
			print(`  ${bold("Open this URL in your browser:")}`);
			print(`  ${cyan(session.authUrl)}`);
			print("");
			print(dim(`  Listening on http://localhost:${ANTHROPIC_CALLBACK_PORT}${ANTHROPIC_CALLBACK_PATH}`));
			print(dim("  (this command will return when the redirect arrives)"));
			print("");
			try {
				const cred = await session.completion;
				const file = readAuthFile();
				file.credentials.anthropic = cred;
				writeAuthFile(file);
				print(green("  Logged in. ") + dim(`Token expires in ${formatExpiry(cred.expires)}.`));
				print(dim("  Stored in ") + authFilePath());
			} catch (err: any) {
				print(red("  Login failed: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "status": {
			const file = readAuthFile();
			print(bold("  Glon auth"));
			print(dim(`  ${authFilePath()}`));
			print("");
			for (const line of describeAnthropicCredential(file.credentials.anthropic)) {
				print(line);
			}
			break;
		}

		case "logout": {
			const provider = args[0] ?? "anthropic";
			const file = readAuthFile();
			if (provider === "all") {
				deleteAuthFile();
				print(yellow("  removed all credentials"));
				break;
			}
			if (provider !== "anthropic") {
				print(red(`Unknown provider: ${provider}`));
				break;
			}
			if (!file.credentials.anthropic) {
				print(dim("  no anthropic credential stored"));
				break;
			}
			delete file.credentials.anthropic;
			if (Object.keys(file.credentials).length === 0) {
				deleteAuthFile();
			} else {
				writeAuthFile(file);
			}
			print(yellow("  removed anthropic credential"));
			break;
		}

		case "refresh": {
			const provider = args[0] ?? "anthropic";
			if (provider !== "anthropic") {
				print(red(`Unknown provider: ${provider}`));
				break;
			}
			try {
				const result = await forceRefreshAnthropic(state);
				if (!result) {
					print(red("  no oauth credential to refresh"));
					print(dim("  Run ") + cyan("/auth login anthropic") + dim(" first."));
					break;
				}
				const file = readAuthFile();
				const cred = file.credentials.anthropic;
				if (cred?.type === "oauth") {
					print(green("  refreshed. ") + dim(`expires in ${formatExpiry(cred.expires)}`));
				} else {
					print(green("  refreshed."));
				}
			} catch (err: any) {
				print(red("  Refresh failed: ") + (err?.message ?? String(err)));
				print(dim("  You may need to log in again: ") + cyan("/auth login anthropic"));
			}
			break;
		}

		default: {
			print([
				bold("  Auth"),
				`    ${cyan("auth login")} ${dim("[anthropic]")}            Run interactive OAuth, save token`,
				`    ${cyan("auth status")}                       Show current credential, expiry`,
				`    ${cyan("auth refresh")} ${dim("[anthropic]")}          Force a token refresh`,
				`    ${cyan("auth logout")} ${dim("[anthropic|all]")}        Delete stored credentials`,
				"",
				dim(`  Credentials live in ${authFilePath()} (mode 0600).`),
				dim(`  Anthropic env var ${process.env.ANTHROPIC_API_KEY ? "is" : "is NOT"} set; OAuth in auth.json takes precedence.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API for /agent) ──────────────────────────

const actorDef: ProgramActorDef = {
	createState: (): ResolverState => ({ refreshInflight: null }),

	actions: {
		/**
		 * Returns a usable Anthropic credential or null. Refreshes if the
		 * stored OAuth token is within the expiry buffer. Other programs
		 * (currently /agent) call this before every request.
		 */
		getAnthropic: async (ctx: ProgramContext): Promise<ResolvedAnthropicCredential | null> => {
			return await resolveAnthropic(ctx.state as ResolverState);
		},

		/**
		 * Force-refresh and return the new credential. Called by /agent on
		 * 401 responses, when local expiry tracking might be wrong.
		 */
		refreshAnthropic: async (ctx: ProgramContext): Promise<ResolvedAnthropicCredential | null> => {
			return await forceRefreshAnthropic(ctx.state as ResolverState);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	authFilePath,
	readAuthFile,
	writeAuthFile,
	deleteAuthFile,
	generatePkce,
	base64UrlEncode,
	resolveAnthropic,
	forceRefreshAnthropic,
};
