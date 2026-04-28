// Auth — manage credentials for external LLM providers.
//
// First and only provider today: Anthropic via Claude Pro/Max. The OAuth
// flow uses Authorization Code + PKCE against claude.ai/oauth/authorize
// with the public Claude Code client_id. We use Anthropic's hosted callback
// (console.anthropic.com/oauth/code/callback) because that's the only
// redirect URI registered against the public Claude Code client; localhost
// callbacks are rejected with HTTP 400 "invalid request format". The flow
// is two-step copy/paste:
//
//   /auth login anthropic           prints the PKCE URL
//   /auth login anthropic <code>    exchanges the code from claude.ai's success page
//
// Subsequent requests authenticate as "Claude Code" so traffic bills against
// the user's Pro/Max subscription rather than API credits.
//
// Storage is intentionally NOT in the DAG. Credentials expire and rotate;
// committing every refresh to an append-only log is wasteful, leaks tokens
// to peers when objects sync, and makes "logout" impossible. They live in
// a flat JSON file under GLON_DATA, mode 0600, written atomically.
//
// The pending PKCE verifier between login start and finish lives in module
// state, not actor state: the runtime hands CLI handlers a fresh per-call
// ctx with `state: {}`, so the bundled module scope is the only place that
// survives across two handler invocations in the same process.
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
//   - The OAuth client_id, redirect URI, and scope set must match what
//     Anthropic registered for the public Claude Code client. If any drifts
//     server-side, requests are rejected before the token endpoint — fix
//     the constants below to match the current claude code build.
//   - The "Claude Code" version number, beta strings, and X-Stainless
//     headers are part of the impersonation. They drift over time as the
//     official CLI updates. Bump them in agent.ts when requests start
//     failing with 4xx; this file owns the auth flow only.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
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
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";

// Refresh tokens once we're within this many ms of expiry.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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


// ── Anthropic OAuth flow ─────────────────────────────────────────

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

async function exchangeAnthropicCode(args: {
	rawCode: string;
	verifier: string;
	redirectUri: string;
}): Promise<AnthropicOAuthCredential> {
	// claude.ai's success page may show the code as `CODE#STATE`; if so we
	// forward the state. If not, the OAuth gist convention is to pass the
	// PKCE verifier as the state value.
	const [code, state] = args.rawCode.split("#");
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: ANTHROPIC_CLIENT_ID,
			code,
			state: state ?? args.verifier,
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

/**
 * Module-level state for an in-flight login. Not actor state: the CLI handler
 * receives a fresh ctx with `state: {}` per invocation, so anything we need to
 * carry between `/auth login anthropic` (start) and `/auth login anthropic
 * <code>` (finish) lives here in the bundled module scope.
 */
let pendingAnthropicLogin: { verifier: string; redirectUri: string } | null = null;

interface StartedLogin {
	authUrl: string;
	verifier: string;
	redirectUri: string;
}

/**
 * Generate PKCE and return the URL the user opens in their browser. The user
 * authenticates on claude.ai which then displays a code (or CODE#STATE) on a
 * success page. They paste that back via `/auth login anthropic <code>`,
 * which calls `exchangeAnthropicCode` with the verifier kept in module state.
 */
function startAnthropicLogin(): StartedLogin {
	const pkce = generatePkce();
	const params = new URLSearchParams({
		code: "true",
		client_id: ANTHROPIC_CLIENT_ID,
		response_type: "code",
		redirect_uri: ANTHROPIC_REDIRECT_URI,
		scope: ANTHROPIC_SCOPES,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state: pkce.verifier,
	});
	return {
		authUrl: `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`,
		verifier: pkce.verifier,
		redirectUri: ANTHROPIC_REDIRECT_URI,
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
			const code = args[1];

			if (!code) {
				// Step 1: print the URL, stash the verifier in module state.
				const started = startAnthropicLogin();
				pendingAnthropicLogin = {
					verifier: started.verifier,
					redirectUri: started.redirectUri,
				};
				print("");
				print(`  ${bold("Open this URL in your browser:")}`);
				print(`  ${cyan(started.authUrl)}`);
				print("");
				print(dim("  Sign in with the Claude account that owns your Pro/Max plan."));
				print(dim("  When approved, claude.ai will display a code (often as CODE#STATE)."));
				print("");
				print(dim("  Paste it back here with:"));
				print(`    ${cyan("/auth login anthropic <code>")}`);
				break;
			}

			// Step 2: exchange the pasted code for a token.
			if (!pendingAnthropicLogin) {
				print(red("  No pending login."));
				print(dim("  Run ") + cyan("/auth login anthropic") + dim(" first to get a URL."));
				break;
			}
			const { verifier, redirectUri } = pendingAnthropicLogin;
			try {
				const cred = await exchangeAnthropicCode({ rawCode: code, verifier, redirectUri });
				const file = readAuthFile();
				file.credentials.anthropic = cred;
				writeAuthFile(file);
				pendingAnthropicLogin = null;
				print(green("  Logged in. ") + dim(`Token expires in ${formatExpiry(cred.expires)}.`));
				print(dim("  Stored in ") + authFilePath());
			} catch (err: any) {
				print(red("  Login failed: ") + (err?.message ?? String(err)));
				print(dim("  The code is single-use; restart with ") + cyan("/auth login anthropic"));
				pendingAnthropicLogin = null;
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
				`    ${cyan("auth login")} ${dim("[anthropic]")}            Start OAuth — prints a URL to approve in your browser`,
				`    ${cyan("auth login")} ${dim("[anthropic] <code>")}     Finish OAuth — paste the code from claude.ai's success page`,
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
