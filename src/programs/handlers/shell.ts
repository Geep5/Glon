// Shell — persistent bash sessions for Glon agents.
//
// Gracie (or any agent) gets full bash. Each session is a long-lived `bash -l`
// subprocess: cwd persists, env vars persist, aliases work, PATH is what a
// human would see at their terminal. Commands are sent over stdin and we
// detect completion via a per-call UUID sentinel printed on both stdout and
// stderr after the user's command finishes.
//
// No allowlist. No confirmation gate. No sandboxing. The agent runs in the
// daemon's user context and can do everything that user can do. This is
// intentional — Glon's shell is a foundation tool for agents that need to
// "use" the machine, same as a human operator would.
//
// Audit trail lives in the calling agent's own DAG: every shell_exec becomes
// a tool_use + tool_result block pair on the agent's conversation, with the
// command and output captured verbatim. Walk `/agent history <id>` to review.
//
// Sessions are keyed by a caller-provided name (default "main"). Multiple
// named sessions let agents run parallel work — one for "repo1", one for
// "deploy", etc. Each session serializes its own exec calls.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_MAX_BYTES = 32_768;
const DEFAULT_SESSION = "main";
const DEFAULT_CWD = process.env.GLON_SHELL_CWD ?? process.env.HOME ?? process.cwd();

// ── Types ────────────────────────────────────────────────────────

interface ExecResult {
	session: string;
	command: string;
	stdout: string;
	stderr: string;
	exit_code: number;
	duration_ms: number;
	cwd: string;
	timed_out: boolean;
	truncated: boolean;
}

interface SessionInfo {
	name: string;
	cwd: string;
	alive: boolean;
	created_at: number;
	last_used: number;
	exec_count: number;
}

// ── Session ──────────────────────────────────────────────────────

class ShellSession {
	name: string;
	cwd: string;
	created_at: number;
	last_used: number;
	exec_count = 0;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(name: string, cwd: string) {
		this.name = name;
		this.cwd = cwd;
		this.created_at = Date.now();
		this.last_used = this.created_at;
	}

	isAlive(): boolean {
		return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
	}

	private ensureAlive() {
		if (this.isAlive()) return;
		// `bash -l` sources the user's login profile so PATH, aliases, and env
		// match what a human gets in a fresh terminal. Piped stdio ⇒ non-interactive
		// (no prompt, no line echo, no readline), which is exactly what we want
		// for a programmatic driver.
		this.proc = spawn("bash", ["-l"], {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// If bash dies unexpectedly, mark dead so the next exec respawns.
		this.proc.on("exit", () => { this.proc = null; });
		this.proc.on("error", () => { this.proc = null; });
	}

	/** Serialize exec calls so one session never runs two commands concurrently. */
	async exec(command: string, timeoutMs: number): Promise<ExecResult> {
		const next = this.queue.then(() => this.execInner(command, timeoutMs));
		// Don't let a rejection poison subsequent calls in the chain.
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async execInner(command: string, timeoutMs: number): Promise<ExecResult> {
		this.ensureAlive();
		const proc = this.proc!;
		const startedAt = Date.now();
		const sentinel = `__GLON_${randomUUID().replace(/-/g, "").slice(0, 20)}__`;
		const outEnd = `${sentinel}STDOUT:`;
		const errEnd = `${sentinel}STDERR:`;

		// Wrap the user command in a block so its exit code is the block's exit
		// code. After it finishes we:
		//   1. Print the stdout sentinel with exit code and cwd.
		//   2. Print the stderr sentinel (so stderr reader also knows we're done).
		// Trailing newline matters — printf doesn't emit one by default.
		const wrapped =
			`{ ${command}\n} ; __GLON_EXIT=$?\n` +
			`printf '\\n%s%d:%s\\n' '${errEnd}' "$__GLON_EXIT" "$(pwd)" 1>&2\n` +
			`printf '\\n%s%d:%s\\n' '${outEnd}' "$__GLON_EXIT" "$(pwd)"\n`;

		let stdoutBuf = "";
		let stderrBuf = "";
		let exitCode = -1;
		let finalCwd = this.cwd;
		let stdoutDone = false;
		let stderrDone = false;
		let stdoutResolve!: () => void;
		let stderrResolve!: () => void;
		const stdoutP = new Promise<void>((r) => { stdoutResolve = r; });
		const stderrP = new Promise<void>((r) => { stderrResolve = r; });

		const onStdout = (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
			const i = stdoutBuf.indexOf(outEnd);
			if (i >= 0 && !stdoutDone) {
				const after = stdoutBuf.slice(i + outEnd.length);
				// after looks like: "<exit>:<cwd>\n"
				const line = after.split("\n")[0];
				const colon = line.indexOf(":");
				if (colon >= 0) {
					exitCode = parseInt(line.slice(0, colon), 10);
					finalCwd = line.slice(colon + 1).trimEnd();
				}
				stdoutBuf = stdoutBuf.slice(0, i).replace(/\n$/, "");
				stdoutDone = true;
				stdoutResolve();
			}
		};
		const onStderr = (chunk: Buffer) => {
			stderrBuf += chunk.toString();
			const i = stderrBuf.indexOf(errEnd);
			if (i >= 0 && !stderrDone) {
				stderrBuf = stderrBuf.slice(0, i).replace(/\n$/, "");
				stderrDone = true;
				stderrResolve();
			}
		};

		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", onStderr);

		// Submit the wrapped command.
		proc.stdin.write(wrapped);

		let timedOut = false;
		const effectiveTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
		const timeoutP = new Promise<void>((resolve) => {
			setTimeout(() => {
				if (!stdoutDone || !stderrDone) {
					timedOut = true;
					// If bash is wedged on a hanging child (e.g. `sleep 9999`), SIGINT
					// the whole bash process — simpler than trying to reach inside and
					// kill just the hung child. Next exec respawns.
					try { proc.kill("SIGINT"); } catch { /* best-effort */ }
					// If SIGINT didn't wake things, SIGTERM shortly after.
					setTimeout(() => {
						if (this.isAlive()) { try { proc.kill("SIGTERM"); } catch { /* */ } }
					}, 500);
				}
				resolve();
			}, effectiveTimeout);
		});

		await Promise.race([Promise.all([stdoutP, stderrP]), timeoutP]);

		proc.stdout.off("data", onStdout);
		proc.stderr.off("data", onStderr);

		if (timedOut) {
			// Session is almost certainly poisoned — kill the whole bash so the next
			// exec gets a fresh one at the last-known cwd.
			this.kill();
		}

		this.last_used = Date.now();
		this.exec_count++;
		this.cwd = finalCwd;

		const { text: stdoutClipped, truncated: stdoutTrunc } = truncate(stdoutBuf);
		const { text: stderrClipped, truncated: stderrTrunc } = truncate(stderrBuf);

		return {
			session: this.name,
			command,
			stdout: stdoutClipped,
			stderr: stderrClipped,
			exit_code: timedOut ? -1 : exitCode,
			duration_ms: Date.now() - startedAt,
			cwd: finalCwd,
			timed_out: timedOut,
			truncated: stdoutTrunc || stderrTrunc,
		};
	}

	kill() {
		if (this.proc) {
			try { this.proc.kill("SIGKILL"); } catch { /* */ }
			this.proc = null;
		}
	}

	info(): SessionInfo {
		return {
			name: this.name,
			cwd: this.cwd,
			alive: this.isAlive(),
			created_at: this.created_at,
			last_used: this.last_used,
			exec_count: this.exec_count,
		};
	}
}

function truncate(s: string): { text: string; truncated: boolean } {
	if (s.length <= OUTPUT_MAX_BYTES) return { text: s, truncated: false };
	const overflow = s.length - OUTPUT_MAX_BYTES;
	return {
		text: s.slice(0, OUTPUT_MAX_BYTES) + `\n[truncated — ${overflow} more bytes]`,
		truncated: true,
	};
}

// ── Session registry (per actor) ─────────────────────────────────

function getSessions(state: Record<string, any>): Map<string, ShellSession> {
	if (!state.__sessions) state.__sessions = new Map<string, ShellSession>();
	return state.__sessions as Map<string, ShellSession>;
}

function getOrCreateSession(state: Record<string, any>, name: string): ShellSession {
	const sessions = getSessions(state);
	let s = sessions.get(name);
	if (!s) {
		s = new ShellSession(name, DEFAULT_CWD);
		sessions.set(name, s);
	}
	return s;
}

// ── Core ops ─────────────────────────────────────────────────────

interface ExecInput {
	command?: string;
	session?: string;
	timeout_ms?: number;
}

async function doExec(input: ExecInput, state: Record<string, any>): Promise<ExecResult> {
	const command = input.command;
	if (typeof command !== "string" || command.trim().length === 0) {
		throw new Error("shell.exec: `command` is required (a bash command string)");
	}
	const name = typeof input.session === "string" && input.session ? input.session : DEFAULT_SESSION;
	const timeout = typeof input.timeout_ms === "number" && input.timeout_ms > 0
		? input.timeout_ms
		: DEFAULT_TIMEOUT_MS;
	const session = getOrCreateSession(state, name);
	return await session.exec(command, timeout);
}

function doKill(input: { session?: string }, state: Record<string, any>): { session: string; killed: boolean } {
	const name = typeof input?.session === "string" && input.session ? input.session : DEFAULT_SESSION;
	const sessions = getSessions(state);
	const s = sessions.get(name);
	if (!s) return { session: name, killed: false };
	s.kill();
	sessions.delete(name);
	return { session: name, killed: true };
}

function doListSessions(state: Record<string, any>): SessionInfo[] {
	const sessions = getSessions(state);
	return Array.from(sessions.values()).map((s) => s.info());
}

// ── CLI handler (diagnostics) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, state } = ctx;

	switch (cmd) {
		// /shell exec <command...> [--session NAME] [--timeout MS]
		case "exec": {
			let session: string | undefined;
			let timeout: number | undefined;
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--session" && args[i + 1]) { session = args[++i]; }
				else if (args[i] === "--timeout" && args[i + 1]) { timeout = parseInt(args[++i], 10); }
				else positional.push(args[i]);
			}
			const command = positional.join(" ");
			if (!command) { print(red("Usage: shell exec <command...> [--session NAME] [--timeout MS]")); break; }
			try {
				const r = await doExec({ command, session, timeout_ms: timeout }, state);
				const codeColor = r.exit_code === 0 ? green : red;
				print(dim(`  ${r.session}`) + "  " + cyan(r.cwd));
				if (r.stdout) {
					for (const line of r.stdout.split("\n")) print(`    ${line}`);
				}
				if (r.stderr) {
					for (const line of r.stderr.split("\n")) print(`    ${yellow(line)}`);
				}
				const timeoutTag = r.timed_out ? red("  TIMED OUT") : "";
				const truncTag = r.truncated ? yellow("  (truncated)") : "";
				print(dim(`  exit ${codeColor(String(r.exit_code))}  ${r.duration_ms}ms${timeoutTag}${truncTag}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /shell kill [--session NAME]
		case "kill": {
			let session: string | undefined;
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--session" && args[i + 1]) { session = args[++i]; }
			}
			const r = doKill({ session }, state);
			if (r.killed) print(green(`  killed session ${r.session}`));
			else print(dim(`  no such session: ${r.session}`));
			break;
		}

		// /shell sessions
		case "sessions":
		case "list": {
			const sessions = doListSessions(state);
			if (sessions.length === 0) { print(dim("  (no sessions)")); break; }
			print(bold(`  ${sessions.length} session(s)`));
			for (const s of sessions) {
				const alive = s.alive ? green("alive") : dim("dead ");
				const age = Math.round((Date.now() - s.last_used) / 1000);
				print(`    ${alive}  ${cyan(s.name.padEnd(10))}  ${s.cwd}  ${dim(`${s.exec_count} exec, ${age}s idle`)}`);
			}
			break;
		}

		default: {
			print([
				bold("  Shell") + dim(" — persistent bash sessions"),
				`    ${cyan("shell exec")} ${dim("<command...> [--session NAME] [--timeout MS]")}`,
				`    ${cyan("shell sessions")}                  ${dim("list live sessions")}`,
				`    ${cyan("shell kill")} ${dim("[--session NAME]")}    ${dim("respawn a session")}`,
				"",
				dim("  Full bash semantics: pipes, redirects, $VARS, backgrounding, globbing."),
				dim("  Sessions persist cwd and env across calls. Default session: \"main\"."),
			].join("\n"));
		}
	}
};

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),

	onDestroy: async (ctx: ProgramContext) => {
		// Best-effort kill all sessions when the program actor tears down.
		const sessions = getSessions(ctx.state);
		for (const s of sessions.values()) s.kill();
		sessions.clear();
	},

	actions: {
		/** Run a bash command in a named session (default "main"). Sessions are
		 *  long-lived bash -l subprocesses; cwd and env persist across calls. */
		exec: async (ctx: ProgramContext, input: unknown) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : (input ?? {});
			return await doExec(parsed as ExecInput, ctx.state);
		},

		/** Kill + discard a session. Next exec with that name will start a fresh
		 *  bash (no cwd preserved). Use after a hang or to reset state. */
		kill: async (ctx: ProgramContext, input: unknown) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : (input ?? {});
			return doKill(parsed as { session?: string }, ctx.state);
		},

		/** List live sessions with cwd, exec count, idle time. */
		list_sessions: async (ctx: ProgramContext) => {
			return doListSessions(ctx.state);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	ShellSession,
	doExec,
	doKill,
	doListSessions,
	truncate,
};
