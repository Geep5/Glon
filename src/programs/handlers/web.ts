// Web — HTTP fetch primitive for any Glon agent.
//
// This is a shared primitive, not an agent-specific tool. Any agent that
// wants internet access registers tools pointing at /web.fetch,
// /web.get_text, or /web.get_json. Agent-specific policy (whitelists,
// auth injection, rate limits) lives in the wrapping program's
// registration, not here — `/web` stays dumb and deterministic.
//
// Actions (all accept object input for tool-use compatibility):
//   fetch({url, method?, headers?, body?, max_bytes?, timeout_ms?})
//     Full HTTP. Returns {status, status_text, headers, body, bytes, truncated, url_fetched}
//   get_text({url, max_bytes?, timeout_ms?})
//     Shorthand: GET, decode as UTF-8 text. Returns {status, text, truncated, bytes}
//   get_json({url, headers?, timeout_ms?})
//     Shorthand: GET, parse as JSON. Returns {status, json} or {status, error}
//
// Safety:
//   - Default max_bytes 16384; hard max 1_048_576 (1 MB).
//   - Default timeout 30s; hard max 120s.
//   - SSRF guard: blocks file://, data://, and URLs resolving to
//     localhost / private IPs. Opt-out via allow_internal=true for tests.
//   - No npm deps — uses Node's built-in fetch + AbortController.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 16 * 1024;
const HARD_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

const BLOCKED_PROTOCOLS = new Set(["file:", "data:", "javascript:"]);
const PRIVATE_HOST_RE = /^(localhost$|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fe80:|fc00:|fd00:|0\.0\.0\.0$)/i;

// ── Types ────────────────────────────────────────────────────────

interface FetchInput {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | unknown;
	max_bytes?: number;
	timeout_ms?: number;
	allow_internal?: boolean;
}

interface FetchResult {
	status: number;
	status_text: string;
	headers: Record<string, string>;
	body: string;
	bytes: number;
	truncated: boolean;
	url_fetched: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function asObj(input: unknown): Record<string, any> {
	if (input && typeof input === "object" && !Array.isArray(input)) return input as any;
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { /* fall through */ }
	}
	return {};
}

/** SSRF guard: reject URLs we shouldn't hit. Raises on problems. */
function guardUrl(raw: string, allowInternal: boolean): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`invalid URL: ${raw}`);
	}
	if (BLOCKED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`blocked protocol: ${url.protocol}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`only http/https allowed, got ${url.protocol}`);
	}
	if (!allowInternal) {
		// URL.hostname includes brackets for IPv6 literals (e.g. '[::1]'); strip them.
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (PRIVATE_HOST_RE.test(host)) {
			throw new Error(`refusing to fetch private/internal host: ${url.hostname}`);
		}
	}
	return url;
}

function clampMaxBytes(raw: unknown): number {
	if (typeof raw !== "number" || raw <= 0) return DEFAULT_MAX_BYTES;
	return Math.min(Math.floor(raw), HARD_MAX_BYTES);
}

function clampTimeoutMs(raw: unknown): number {
	if (typeof raw !== "number" || raw <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.floor(raw), HARD_MAX_TIMEOUT_MS);
}

/** Read body up to maxBytes, return {text, bytes, truncated}. */
async function readBodyWithCap(
	res: Response,
	maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: "", bytes: 0, truncated: false };

	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = maxBytes - total;
		if (remaining <= 0) {
			truncated = true;
			await reader.cancel().catch(() => { /* ignore */ });
			break;
		}
		if (value.byteLength > remaining) {
			chunks.push(value.subarray(0, remaining));
			total += remaining;
			truncated = true;
			await reader.cancel().catch(() => { /* ignore */ });
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
	return { text: buf.toString("utf-8"), bytes: total, truncated };
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => { out[key] = value; });
	return out;
}

// ── Core: fetch ──────────────────────────────────────────────────

async function doFetch(input: FetchInput): Promise<FetchResult> {
	// Test hook for deterministic mocking (like __ANTHROPIC_FETCH).
	const testFetch = (globalThis as any).__WEB_FETCH as
		| undefined
		| ((req: FetchInput) => Promise<FetchResult>);
	if (testFetch) return testFetch(input);

	const url = guardUrl(input.url, !!input.allow_internal);
	const method = (input.method ?? "GET").toUpperCase();
	const maxBytes = clampMaxBytes(input.max_bytes);
	const timeoutMs = clampTimeoutMs(input.timeout_ms);

	let bodyInit: string | undefined;
	if (input.body !== undefined && input.body !== null) {
		bodyInit = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(url.href, {
			method,
			headers: input.headers,
			body: bodyInit,
			signal: controller.signal,
			redirect: "follow",
		});
		const { text, bytes, truncated } = await readBodyWithCap(res, maxBytes);
		return {
			status: res.status,
			status_text: res.statusText,
			headers: headersToObject(res.headers),
			body: text,
			bytes,
			truncated,
			url_fetched: res.url || url.href,
		};
	} catch (err: any) {
		if (err?.name === "AbortError") {
			throw new Error(`fetch timed out after ${timeoutMs}ms: ${url.href}`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function doGetText(input: { url: string; max_bytes?: number; timeout_ms?: number; allow_internal?: boolean }) {
	const r = await doFetch({ ...input, method: "GET" });
	return {
		status: r.status,
		status_text: r.status_text,
		text: r.body,
		bytes: r.bytes,
		truncated: r.truncated,
		url_fetched: r.url_fetched,
	};
}

async function doGetJson(input: { url: string; headers?: Record<string, string>; timeout_ms?: number; allow_internal?: boolean }) {
	const r = await doFetch({ ...input, method: "GET", max_bytes: HARD_MAX_BYTES });
	let json: unknown;
	let parseError: string | undefined;
	try {
		json = JSON.parse(r.body);
	} catch (err: any) {
		parseError = err?.message ?? String(err);
	}
	return {
		status: r.status,
		status_text: r.status_text,
		json,
		parse_error: parseError,
		truncated: r.truncated,
		url_fetched: r.url_fetched,
	};
}

// ── Handler (CLI subcommands) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "status": {
			print(bold("  Web"));
			print(dim(`  default max_bytes: ${DEFAULT_MAX_BYTES}`));
			print(dim(`  hard max_bytes:    ${HARD_MAX_BYTES}`));
			print(dim(`  default timeout:   ${DEFAULT_TIMEOUT_MS}ms`));
			print(dim(`  hard max timeout:  ${HARD_MAX_TIMEOUT_MS}ms`));
			print(dim(`  SSRF guard:        active (block private/internal hosts)`));
			break;
		}

		case "fetch":
		case "get": {
			const url = args[0];
			if (!url) { print(red("Usage: /web fetch <url>")); break; }
			try {
				const r = await doFetch({ url, method: "GET" });
				print(dim(`  ${r.status} ${r.status_text}  ${r.url_fetched}  (${r.bytes} bytes${r.truncated ? ", truncated" : ""})`));
				print("");
				for (const line of r.body.split("\n").slice(0, 20)) print(`  ${line}`);
				if (r.body.split("\n").length > 20) print(dim("  ..."));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "get-text": {
			const url = args[0];
			if (!url) { print(red("Usage: /web get-text <url>")); break; }
			try {
				const r = await doGetText({ url });
				print(dim(`  ${r.status} ${r.status_text}  ${r.url_fetched}  (${r.bytes} bytes${r.truncated ? ", truncated" : ""})`));
				for (const line of r.text.split("\n").slice(0, 30)) print(`  ${line}`);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "get-json": {
			const url = args[0];
			if (!url) { print(red("Usage: /web get-json <url>")); break; }
			try {
				const r = await doGetJson({ url });
				if (r.parse_error) {
					print(red(`  parse error: ${r.parse_error}`));
					break;
				}
				print(green(`  ${r.status}`) + dim(`  ${r.url_fetched}`));
				print(JSON.stringify(r.json, null, 2).split("\n").slice(0, 40).map((l) => "  " + l).join("\n"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Web") + dim(" — HTTP fetch primitive"),
				`    ${cyan("web status")}                          show limits`,
				`    ${cyan("web fetch")} ${dim("<url>")}                    GET a URL, print body`,
				`    ${cyan("web get-text")} ${dim("<url>")}                 GET + decode UTF-8`,
				`    ${cyan("web get-json")} ${dim("<url>")}                 GET + parse JSON`,
				"",
				dim(`  Hard limits: ${HARD_MAX_BYTES} bytes, ${HARD_MAX_TIMEOUT_MS}ms`),
				dim(`  SSRF guard blocks localhost/private IPs (opt out via allow_internal=true).`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		fetch: async (_ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			if (!o.url || typeof o.url !== "string") throw new Error("fetch: url required");
			return await doFetch(o as FetchInput);
		},
		get_text: async (_ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			if (!o.url || typeof o.url !== "string") throw new Error("get_text: url required");
			return await doGetText(o as any);
		},
		get_json: async (_ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			if (!o.url || typeof o.url !== "string") throw new Error("get_json: url required");
			return await doGetJson(o as any);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	doFetch,
	doGetText,
	doGetJson,
	guardUrl,
	clampMaxBytes,
	clampTimeoutMs,
	readBodyWithCap,
};
