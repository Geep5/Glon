// Google — bridge to the Google Workspace CLI (`gws`).
//
// Wraps gws's +helper commands as typed actor actions so Gracie can reach
// Calendar, Gmail, Drive, Sheets, and Docs via normal tool calls. gws itself
// handles OAuth, token refresh, scope gating, and encrypted credential
// storage in the OS keyring — we just spawn it.
//
// Design:
//   - Each action maps 1:1 to a `gws <service> <+helper | resource verb>` invocation.
//   - Input fields become CLI flags via `flagsFrom`. Booleans become bare flags
//     when true; arrays produce repeated flags (e.g. multiple --attendee).
//   - Mutations (send, insert, append, write) are gated: callers must pass
//     either `confirmed: true` (actual execution) or `dry_run: true` (preview
//     without side effects via gws's --dry-run). Neither → action throws.
//   - stdout of gws is always JSON; we parse and return structured results.
//   - stderr contains diagnostic lines ("Using keyring backend: …") that we
//     ignore on success. On non-zero exit, we return the gws error JSON (or
//     stderr text if JSON parsing failed) as a structured error.
//
// Why a subprocess and not a Node SDK: gws already solves auth, refresh,
// keyring, scopes, and the entire discovery-driven command surface. Using
// googleapis in-process would duplicate that work and fork Gracie's auth
// state from Grant's own gws use. The subprocess boundary is correct here.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { spawn } from "node:child_process";

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

// ── Config ───────────────────────────────────────────────────────

const GWS_BINARY = process.env.GLON_GWS_BINARY ?? "gws";
const GWS_TIMEOUT_MS = 30_000;

// ── Subprocess runner ────────────────────────────────────────────

interface GwsSuccess { ok: true; data: any; }
interface GwsFailure { ok: false; error: string; exit_code?: number; }
type GwsResult = GwsSuccess | GwsFailure;

/** Spawn gws with args, collect stdout as JSON. Returns structured result. */
async function runGws(args: string[]): Promise<GwsResult> {
	return new Promise((resolve) => {
		let proc;
		try {
			// Force JSON output — +helper commands default to table format,
			// which our parser can't handle.
			const withFormat = args.includes("--format") ? args : [...args, "--format", "json"];
			proc = spawn(GWS_BINARY, withFormat, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err: any) {
			resolve({ ok: false, error: `failed to spawn ${GWS_BINARY}: ${err?.message ?? String(err)}` });
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { proc.kill("SIGTERM"); } catch { /* best-effort */ }
			resolve({ ok: false, error: `gws timed out after ${GWS_TIMEOUT_MS}ms` });
		}, GWS_TIMEOUT_MS);

		proc.stdout?.on("data", (b) => { stdout += b.toString(); });
		proc.stderr?.on("data", (b) => { stderr += b.toString(); });

		proc.on("error", (err: any) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			const hint = err.code === "ENOENT"
				? `${GWS_BINARY} not found on PATH. Install gws: https://github.com/googleworkspace/cli`
				: err.message;
			resolve({ ok: false, error: hint });
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			const parsed = parseGwsOutput(stdout);
			if (code === 0) {
				if (!parsed) {
					resolve({ ok: false, error: `gws exited 0 but output was not JSON: ${stdout.slice(0, 500)}`, exit_code: 0 });
					return;
				}
				resolve({ ok: true, data: parsed });
				return;
			}

			// Non-zero exit. gws usually still prints error JSON to stdout; use that
			// for structured reporting, fall back to stderr text.
			if (parsed && typeof parsed === "object" && parsed.error) {
				resolve({ ok: false, error: JSON.stringify(parsed.error), exit_code: code ?? undefined });
				return;
			}
			const stderrTrim = stderr.trim() || stdout.trim() || `gws exited ${code}`;
			resolve({ ok: false, error: stderrTrim.slice(0, 1000), exit_code: code ?? undefined });
		});
	});
}

/** gws may emit a non-JSON first line ("Using keyring backend: keyring") before the
 *  JSON body. Find the first `{` or `[` and attempt parse from there. */
function parseGwsOutput(s: string): any | null {
	const trimmed = s.trim();
	if (!trimmed) return null;
	try { return JSON.parse(trimmed); } catch { /* fall through */ }
	const candidates = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0);
	if (candidates.length === 0) return null;
	const start = Math.min(...candidates);
	try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
}

// ── Input → CLI flag translation ─────────────────────────────────

/** Turn an input object into a list of CLI flags.
 *  - Strings/numbers → `--key value`
 *  - `true` booleans → `--key` (no value)
 *  - `false` booleans → dropped
 *  - Arrays → repeated `--key value` (one per element)
 *  - undefined / null → dropped
 *  Only keys in `allow` survive. */
function flagsFrom(input: Record<string, unknown>, allow: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [key, cliName] of Object.entries(allow)) {
		const v = input[key];
		if (v === undefined || v === null || v === "") continue;
		if (typeof v === "boolean") {
			if (v) out.push(`--${cliName}`);
			continue;
		}
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item === undefined || item === null || item === "") continue;
				out.push(`--${cliName}`, String(item));
			}
			continue;
		}
		out.push(`--${cliName}`, String(v));
	}
	return out;
}

function asObj(input: unknown): Record<string, unknown> {
	if (typeof input === "string") {
		try { return JSON.parse(input) as Record<string, unknown>; } catch { return {}; }
	}
	return (input && typeof input === "object") ? input as Record<string, unknown> : {};
}

// ── Mutation gate ────────────────────────────────────────────────

/** Mutation actions must pass either `confirmed: true` (execute) or
 *  `dry_run: true` (preview via --dry-run). Neither → error the model can
 *  observe and act on (it should announce to Grant first, then retry). */
function resolveMutationMode(input: Record<string, unknown>, actionName: string): "execute" | "dry_run" {
	if (input.confirmed === true) return "execute";
	if (input.dry_run === true) return "dry_run";
	throw new Error(
		`${actionName}: mutating action requires either confirmed=true (execute) or dry_run=true (preview). ` +
		`Announce to Grant what you're about to do, then retry with confirmed=true.`,
	);
}

/** Append --dry-run to the gws invocation when mode is preview. */
function withMutationFlag(args: string[], mode: "execute" | "dry_run"): string[] {
	return mode === "dry_run" ? [...args, "--dry-run"] : args;
}

// ── Action set ───────────────────────────────────────────────────
//
// Each action is a thin wrapper: parse input, build flags, spawn gws, return.
// Field names stay close to gws's own (camelCase for --params JSON, kebab
// for +helper flags) so schema changes in gws propagate with minimal churn.

// ── Calendar ─────────────────────────────────────────────────────

// calendar +agenda [--today|--tomorrow|--week|--days N] [--calendar NAME] [--timezone TZ]
async function calendarAgenda(input: Record<string, unknown>): Promise<GwsResult> {
	const args = ["calendar", "+agenda", ...flagsFrom(input, {
		today: "today", tomorrow: "tomorrow", week: "week",
		days: "days", calendar: "calendar", timezone: "timezone",
	})];
	return runGws(args);
}

// calendar events list --params '{"calendarId":"primary","timeMin":...}'
async function calendarListEvents(input: Record<string, unknown>): Promise<GwsResult> {
	const params: Record<string, unknown> = {
		calendarId: input.calendar_id ?? "primary",
	};
	for (const [inKey, outKey] of [
		["time_min", "timeMin"], ["time_max", "timeMax"], ["max_results", "maxResults"],
		["q", "q"], ["order_by", "orderBy"], ["single_events", "singleEvents"],
	] as [string, string][]) {
		if (input[inKey] !== undefined) params[outKey] = input[inKey];
	}
	// Default to chronologically-sorted, expanded recurring events — what a
	// human assistant expects when asked "what's on my calendar".
	if (params.singleEvents === undefined) params.singleEvents = true;
	if (params.orderBy === undefined) params.orderBy = "startTime";
	return runGws(["calendar", "events", "list", "--params", JSON.stringify(params)]);
}

// calendar +insert --summary --start --end [--description] [--location] [--calendar] [--meet] [--attendee ...]
async function calendarInsert(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "calendar_insert");
	const args = ["calendar", "+insert", ...flagsFrom(input, {
		summary: "summary", start: "start", end: "end",
		description: "description", location: "location",
		calendar: "calendar", meet: "meet", attendees: "attendee",
	})];
	return runGws(withMutationFlag(args, mode));
}

// calendar events delete --params '{"calendarId":...,"eventId":...}'
async function calendarDeleteEvent(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "calendar_delete_event");
	const eventId = input.event_id;
	if (typeof eventId !== "string" || !eventId) {
		return { ok: false, error: "calendar_delete_event: event_id required" };
	}
	const params: Record<string, unknown> = {
		calendarId: input.calendar_id ?? "primary",
		eventId,
	};
	const args = ["calendar", "events", "delete", "--params", JSON.stringify(params)];
	return runGws(withMutationFlag(args, mode));
}

// ── Gmail ────────────────────────────────────────────────────────

// gmail +triage — unread inbox summary (sender/subject/date per message)
async function gmailTriage(input: Record<string, unknown>): Promise<GwsResult> {
	const args = ["gmail", "+triage", ...flagsFrom(input, {
		max: "max", label: "label", query: "query",
	})];
	return runGws(args);
}

// gmail +read --id
async function gmailRead(input: Record<string, unknown>): Promise<GwsResult> {
	const id = input.message_id;
	if (typeof id !== "string" || !id) {
		return { ok: false, error: "gmail_read: message_id required" };
	}
	const args = ["gmail", "+read", "--id", id, ...flagsFrom(input, { headers_only: "headers-only" })];
	return runGws(args);
}

// gmail users messages list — search via q, returns ids only (use gmail_read to fetch)
async function gmailSearch(input: Record<string, unknown>): Promise<GwsResult> {
	const params: Record<string, unknown> = {
		userId: "me",
		q: input.q,
	};
	if (input.max_results !== undefined) params.maxResults = input.max_results;
	if (input.label_ids !== undefined) params.labelIds = input.label_ids;
	return runGws(["gmail", "users", "messages", "list", "--params", JSON.stringify(params)]);
}

// gmail +send --to --subject --body [--cc] [--bcc] [--from] [--html] [--draft]
async function gmailSend(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "gmail_send");
	const args = ["gmail", "+send", ...flagsFrom(input, {
		to: "to", subject: "subject", body: "body",
		cc: "cc", bcc: "bcc", from: "from", html: "html", draft: "draft",
	})];
	return runGws(withMutationFlag(args, mode));
}

// gmail +reply --id --body [--html]
async function gmailReply(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "gmail_reply");
	const args = ["gmail", "+reply", ...flagsFrom(input, {
		message_id: "id", body: "body", html: "html",
	})];
	return runGws(withMutationFlag(args, mode));
}

// ── Drive ────────────────────────────────────────────────────────

// drive files list --params
async function driveSearch(input: Record<string, unknown>): Promise<GwsResult> {
	const params: Record<string, unknown> = {};
	if (input.q !== undefined) params.q = input.q;
	if (input.max_results !== undefined) params.pageSize = input.max_results;
	else params.pageSize = 20;
	params.fields = input.fields ?? "files(id,name,mimeType,modifiedTime,owners(emailAddress))";
	if (input.order_by !== undefined) params.orderBy = input.order_by;
	return runGws(["drive", "files", "list", "--params", JSON.stringify(params)]);
}

// drive files get --params
async function driveGet(input: Record<string, unknown>): Promise<GwsResult> {
	const fileId = input.file_id;
	if (typeof fileId !== "string" || !fileId) {
		return { ok: false, error: "drive_get: file_id required" };
	}
	const params: Record<string, unknown> = {
		fileId,
		fields: input.fields ?? "id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress)",
	};
	return runGws(["drive", "files", "get", "--params", JSON.stringify(params)]);
}

// ── Sheets ───────────────────────────────────────────────────────

// sheets +read --spreadsheet --range
async function sheetsRead(input: Record<string, unknown>): Promise<GwsResult> {
	const args = ["sheets", "+read", ...flagsFrom(input, {
		spreadsheet_id: "spreadsheet", range: "range",
		value_render_option: "value-render-option",
	})];
	return runGws(args);
}

// sheets +append --spreadsheet --range --values
async function sheetsAppend(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "sheets_append");
	// +append takes --values as JSON (array of arrays). Accept either an array
	// or a JSON string from the model.
	const values = input.values;
	const valuesJson = typeof values === "string" ? values : JSON.stringify(values ?? []);
	const args = ["sheets", "+append",
		...flagsFrom(input, { spreadsheet_id: "spreadsheet", range: "range" }),
		"--values", valuesJson,
	];
	return runGws(withMutationFlag(args, mode));
}

// ── Docs ─────────────────────────────────────────────────────────

// docs +write --doc --text
async function docsWrite(input: Record<string, unknown>): Promise<GwsResult> {
	const mode = resolveMutationMode(input, "docs_write");
	const args = ["docs", "+write", ...flagsFrom(input, {
		document_id: "doc", text: "text",
	})];
	return runGws(withMutationFlag(args, mode));
}

// docs documents get --params
async function docsGet(input: Record<string, unknown>): Promise<GwsResult> {
	const id = input.document_id;
	if (typeof id !== "string" || !id) {
		return { ok: false, error: "docs_get: document_id required" };
	}
	return runGws(["docs", "documents", "get", "--params", JSON.stringify({ documentId: id })]);
}

// ── CLI handler (diagnostics only — not the primary path) ────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	async function runAndPrint(actionName: string, fn: () => Promise<GwsResult>) {
		try {
			const r = await fn();
			if (!r.ok) {
				print(red(`  ${actionName} failed: `) + r.error);
				if (r.exit_code !== undefined) print(dim(`  exit_code: ${r.exit_code}`));
				return;
			}
			print(green(`  ${actionName} OK`));
			print(dim(JSON.stringify(r.data, null, 2)));
		} catch (err: any) {
			print(red(`  ${actionName} error: `) + (err?.message ?? String(err)));
		}
	}

	switch (cmd) {
		case "agenda": {
			const input: Record<string, unknown> = {};
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--today") input.today = true;
				else if (args[i] === "--tomorrow") input.tomorrow = true;
				else if (args[i] === "--week") input.week = true;
				else if (args[i] === "--days" && args[i + 1]) { input.days = args[++i]; }
				else if (args[i] === "--calendar" && args[i + 1]) { input.calendar = args[++i]; }
			}
			await runAndPrint("agenda", () => calendarAgenda(input));
			break;
		}
		case "triage": {
			const input: Record<string, unknown> = {};
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--max" && args[i + 1]) { input.max = args[++i]; }
				else if (args[i] === "--label" && args[i + 1]) { input.label = args[++i]; }
				else if (args[i] === "--query" && args[i + 1]) { input.query = args[++i]; }
			}
			await runAndPrint("triage", () => gmailTriage(input));
			break;
		}
		case "status": {
			// Sanity check: can we spawn gws and run a no-op?
			print(cyan("  Probing gws..."));
			const r = await runGws(["--version"]);
			if (r.ok) {
				print(green("  gws reachable"));
				print(dim(`  ${JSON.stringify(r.data)}`));
			} else {
				print(red("  gws not reachable: ") + r.error);
			}
			break;
		}
		default: {
			print([
				bold("  Google") + dim(" — bridge to the Google Workspace CLI (`gws`)"),
				"",
				dim("  This program exists mainly for agents. CLI below is diagnostic."),
				`    ${cyan("google status")}                                   ${dim("check gws binary reachability")}`,
				`    ${cyan("google agenda")} ${dim("[--today|--tomorrow|--week|--days N] [--calendar NAME]")}`,
				`    ${cyan("google triage")} ${dim("[--max N] [--label L] [--query Q]")}`,
				"",
				dim("  Full action list (via dispatch from Gracie or programs):"),
				dim("    calendar_agenda, calendar_list_events, calendar_insert, calendar_delete_event"),
				dim("    gmail_triage, gmail_search, gmail_read, gmail_send, gmail_reply"),
				dim("    drive_search, drive_get"),
				dim("    sheets_read, sheets_append"),
				dim("    docs_get, docs_write"),
				"",
				yellow("  Mutating actions (send/insert/append/write/delete) require"),
				yellow("  confirmed=true OR dry_run=true in the input."),
			].join("\n"));
		}
	}
};

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		// Calendar
		calendar_agenda: async (_ctx: ProgramContext, input: unknown) => calendarAgenda(asObj(input)),
		calendar_list_events: async (_ctx: ProgramContext, input: unknown) => calendarListEvents(asObj(input)),
		calendar_insert: async (_ctx: ProgramContext, input: unknown) => calendarInsert(asObj(input)),
		calendar_delete_event: async (_ctx: ProgramContext, input: unknown) => calendarDeleteEvent(asObj(input)),

		// Gmail
		gmail_triage: async (_ctx: ProgramContext, input: unknown) => gmailTriage(asObj(input)),
		gmail_search: async (_ctx: ProgramContext, input: unknown) => gmailSearch(asObj(input)),
		gmail_read: async (_ctx: ProgramContext, input: unknown) => gmailRead(asObj(input)),
		gmail_send: async (_ctx: ProgramContext, input: unknown) => gmailSend(asObj(input)),
		gmail_reply: async (_ctx: ProgramContext, input: unknown) => gmailReply(asObj(input)),

		// Drive
		drive_search: async (_ctx: ProgramContext, input: unknown) => driveSearch(asObj(input)),
		drive_get: async (_ctx: ProgramContext, input: unknown) => driveGet(asObj(input)),

		// Sheets
		sheets_read: async (_ctx: ProgramContext, input: unknown) => sheetsRead(asObj(input)),
		sheets_append: async (_ctx: ProgramContext, input: unknown) => sheetsAppend(asObj(input)),

		// Docs
		docs_get: async (_ctx: ProgramContext, input: unknown) => docsGet(asObj(input)),
		docs_write: async (_ctx: ProgramContext, input: unknown) => docsWrite(asObj(input)),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	runGws,
	parseGwsOutput,
	flagsFrom,
	resolveMutationMode,
	withMutationFlag,
};
