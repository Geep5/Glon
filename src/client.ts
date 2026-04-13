/**
 * Glon OS CLI shell — minimal program loader.
 *
 * The shell has no built-in commands except /help. Everything else is
 * a program loaded from the store. Programs are Glon objects that can
 * be created, modified, synced, and versioned like any other object.
 *
 * Usage: npm run client / npx tsx src/client.ts
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { createInterface } from "node:readline";
import { diskStats, readChangeByHex, listChangeFiles } from "./disk.js";
import { hexEncode } from "./crypto.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, displayValue } from "./proto.js";
import { loadPrograms, dispatchProgram, startProgramActor, type ProgramContext, type ProgramEntry } from "./programs/runtime.js";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

// ── ANSI helpers ─────────────────────────────────────────────────
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

// ── Client setup ─────────────────────────────────────────────────
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

/** Resolve an id prefix to a full id. Returns null if not found/ambiguous. */
async function resolveId(raw: string): Promise<string | null> {
	if (!raw) return null;
	const exact = await store.exists(raw);
	if (exact) return raw;
	const resolved = await store.resolvePrefix(raw);
	if (resolved) return resolved;
	return null;
}

// ── Program runtime ──────────────────────────────────────────────
let programs: ProgramEntry[] = [];

function buildContext(overrides?: Partial<ProgramContext>): ProgramContext {
	return {
		client,
		store,
		resolveId,
		stringVal,
		intVal,
		floatVal,
		boolVal,
		mapVal,
		listVal,
		displayValue,
		listChangeFiles,
		readChangeByHex,
		hexEncode,
		print: (msg: string) => console.log(msg),
		randomUUID,
		// v2 defaults (overridden by program actors)
		state: {},
		emit: () => {},
		programId: "",
		objectActor: (id: string) => client.objectActor.getOrCreate([id]),
		...overrides,
	};
}

/** The only built-in command: show available programs. */
async function cmdHelp(): Promise<void> {
	if (programs.length === 0) {
		console.log(red("No programs loaded!"));
		console.log(dim("Run 'npm run bootstrap' to seed the initial programs."));
		console.log(dim("Store actor is at: ") + ENDPOINT);
		return;
	}

	console.log(bold("Available programs:"));
	console.log("");

	for (const prog of programs) {
		console.log(cyan(prog.prefix.padEnd(14)) + prog.name);
		if (prog.commands && Object.keys(prog.commands).length > 0) {
			for (const [cmd, desc] of Object.entries(prog.commands)) {
				console.log("  " + dim(cmd.padEnd(12)) + desc);
			}
		}
	}

	console.log("");
	console.log(dim("Type a program prefix to see its commands."));
	console.log(dim("Example: /crud create page MyPage"));
}

// ── Main REPL ────────────────────────────────────────────────────
async function main() {
	console.log(dim("Glon OS — connecting to " + ENDPOINT));

	// Load programs from store
	try {
		const ctx = buildContext();
		programs = await loadPrograms(store, client);
		if (programs.length > 0) {
			console.log(green(`Loaded ${programs.length} programs.`));

			// Start program actors
			for (const prog of programs) {
				try {
					await startProgramActor(prog, client);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.log(red(`Failed to start ${prog.prefix}: ${msg}`));
				}
			}
		} else {
			console.log(red("No programs found!"));
			console.log(dim("Run 'npm run bootstrap' to seed the initial programs."));
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(red("Failed to load programs: ") + msg);
		console.log(dim("Is the server running? Try 'npm run dev' first."));
		process.exit(1);
	}

	// Start REPL
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "glon> ",
	});

	rl.prompt();

	rl.on("line", async (line: string) => {
		const input = line.trim();
		if (!input) {
			rl.prompt();
			return;
		}

		// Special case: /help is the only built-in
		if (input === "/help" || input === "/h" || input === "help") {
			await cmdHelp();
			rl.prompt();
			return;
		}

		// Special case: exit/quit
		if (input === "exit" || input === "quit" || input === "/exit" || input === "/quit") {
			process.exit(0);
		}

		// Everything else goes to programs
		const ctx = buildContext();
		const handled = await dispatchProgram(input, programs, ctx);

		if (!handled) {
			console.log(red("Unknown command: ") + input);
			console.log(dim("Type /help to see available programs."));
		}

		rl.prompt();
	});

	rl.on("SIGINT", () => process.exit(0));
}

// ── Run ──────────────────────────────────────────────────────────
main().catch(err => {
	console.error(red("Fatal error:"), err);
	process.exit(1);
});