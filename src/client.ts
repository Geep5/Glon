/**
 * Glon OS CLI shell.
 *
 * Connects to a running Glon OS instance via Rivet client and provides
 * an interactive command interface for CRUD, IPC, inspection, and search.
 *
 * Usage: npm run client / npx tsx src/client.ts
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { createInterface } from "node:readline";
import { diskStats, readChangeByHex, listChangeFiles } from "./disk.js";
import { hexEncode } from "./crypto.js";
import { stringVal, intVal, floatVal, boolVal, displayValue } from "./proto.js";
import type { Value, Change } from "./proto.js";
import { readBoard, computeMove, renderBoard, renderMoveHistory, newGameFields } from "./programs/tictactoe.js";

const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

// ── ANSI helpers ─────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

// ── Value parsing ────────────────────────────────────────────────

/** Parse a user-supplied string into a proto Value. */
function parseValue(raw: string): Value {
	if (raw === "true") return boolVal(true);
	if (raw === "false") return boolVal(false);
	const n = Number(raw);
	if (!Number.isNaN(n) && raw.trim() !== "") {
		return Number.isInteger(n) ? intVal(n) : floatVal(n);
	}
	return stringVal(raw);
}

// ── Client setup ─────────────────────────────────────────────────

const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

/** Resolve an id prefix to a full id. Returns null if not found/ambiguous. */
async function resolveId(raw: string): Promise<string | null> {
	if (!raw) return null;
	// Try exact match first (fast path for full UUIDs)
	const exact = await store.exists(raw);
	if (exact) return raw;
	// Prefix match
	const resolved = await store.resolvePrefix(raw);
	if (resolved) return resolved;
	return null;
}

// ── Command handlers ─────────────────────────────────────────────

async function cmdCreate(args: string[]): Promise<void> {
	const typeKey = args[0];
	if (!typeKey) {
		console.log(red("Usage: /create <type> [name]"));
		return;
	}
	const name = args.slice(1).join(" ") || typeKey;
	const fieldsJson = JSON.stringify({ name: stringVal(name) });
	const id = await store.create(typeKey, fieldsJson);
	console.log(green("Created: ") + bold(id));
}

async function cmdList(args: string[]): Promise<void> {
	const typeKey = args[0] || undefined;
	const refs = await store.list(typeKey);
	if (refs.length === 0) {
		console.log(dim("(no objects)"));
		return;
	}
	console.log(
		dim("TYPE".padEnd(14) + "ID".padEnd(40) + "UPDATED"),
	);
	for (const r of refs) {
		const shortId = r.id.length > 12 ? r.id.slice(0, 12) + "..." : r.id;
		const updated = r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 19) : "?";
		console.log(
			cyan(r.typeKey.padEnd(14)) +
			dim(shortId.padEnd(40)) +
			updated,
		);
	}
	console.log(dim(`\n${refs.length} object(s)`));
}

async function cmdGet(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) {
		console.log(red("Usage: /get <id>"));
		return;
	}
	const id = await resolveId(raw);
	if (!id) {
		console.log(red("Not found: ") + raw);
		return;
	}
	const state = await store.get(id);
	if (!state) {
		console.log(red("Not found: ") + id);
		return;
	}

	console.log(bold("id:       ") + state.id);
	console.log(bold("type:     ") + state.typeKey);
	console.log(bold("deleted:  ") + String(state.deleted));
	console.log(bold("created:  ") + (state.createdAt ? new Date(state.createdAt).toISOString() : "?"));
	console.log(bold("updated:  ") + (state.updatedAt ? new Date(state.updatedAt).toISOString() : "?"));
	console.log(bold("changes:  ") + String(state.changeCount));

	// Head IDs
	if (state.headIds.length > 0) {
		console.log(bold("heads:    ") + state.headIds.map((h: string) => h.slice(0, 12)).join(", "));
	}

	// Content
	if (state.content) {
		const bytes = Buffer.from(state.content, "base64").byteLength;
		console.log(bold("content:  ") + `${bytes} bytes`);
	} else {
		console.log(bold("content:  ") + dim("(empty)"));
	}

	// Fields
	const fields = state.fields as Record<string, Value> | undefined;
	if (fields && Object.keys(fields).length > 0) {
		console.log(bold("fields:"));
		for (const [k, v] of Object.entries(fields)) {
			console.log(`  ${cyan(k)}: ${displayValue(v)}`);
		}
	}
}

async function cmdSet(args: string[]): Promise<void> {
	if (args.length < 3) {
		console.log(red("Usage: /set <id> <key> <value>"));
		return;
	}
	const resolved = await resolveId(args[0]);
	if (!resolved) { console.log(red("Not found: ") + args[0]); return; }
	const key = args[1];
	const value = parseValue(args.slice(2).join(" "));
	const objActor = client.objectActor.getOrCreate([resolved]);
	await objActor.setField(key, JSON.stringify(value));
	console.log(green("Set ") + cyan(key) + " on " + dim(resolved.slice(0, 12) + "..."));
}

async function cmdDelete(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) {
		console.log(red("Usage: /delete <id>"));
		return;
	}
	const id = await resolveId(raw);
	if (!id) { console.log(red("Not found: ") + raw); return; }
	const ok = await store.delete(id);
	if (ok) {
		console.log(green("Deleted: ") + id);
	} else {
		console.log(red("Not found: ") + id);
	}
}

async function cmdSearch(args: string[]): Promise<void> {
	const query = args.join(" ");
	if (!query) {
		console.log(red("Usage: /search <query>"));
		return;
	}
	const refs = await store.search(query);
	if (refs.length === 0) {
		console.log(dim("(no matches)"));
		return;
	}
	for (const r of refs) {
		const shortId = r.id.length > 12 ? r.id.slice(0, 12) + "..." : r.id;
		console.log(cyan(r.typeKey.padEnd(14)) + dim(shortId.padEnd(40)) + new Date(r.updatedAt).toISOString().slice(0, 19));
	}
	console.log(dim(`\n${refs.length} match(es)`));
}

async function cmdSend(args: string[]): Promise<void> {
	if (args.length < 3) {
		console.log(red("Usage: /send <from-id> <to-id> <action> [payload]"));
		return;
	}
	const [rawFrom, rawTo, action, ...rest] = args;
	const payload = rest.join(" ");

	const fromId = await resolveId(rawFrom);
	if (!fromId) { console.log(red("Sender not found: ") + rawFrom); return; }
	const toId = await resolveId(rawTo);
	if (!toId) { console.log(red("Receiver not found: ") + rawTo); return; }

	const sender = client.objectActor.getOrCreate([fromId]);
	await sender.sendMessage(toId, action, payload);

	const receiver = client.objectActor.getOrCreate([toId]);
	await receiver.receiveMessage(fromId, action, payload, Date.now());

	console.log(green("Sent: ") + `${action} from ${dim(fromId.slice(0, 12))} → ${dim(toId.slice(0, 12))}`);
}

async function cmdInbox(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) { console.log(red("Usage: /inbox <id>")); return; }
	const id = await resolveId(raw);
	if (!id) { console.log(red("Not found: ") + raw); return; }
	const objActor = client.objectActor.getOrCreate([id]);
	const msgs = await objActor.getInbox();
	if (msgs.length === 0) { console.log(dim("(empty inbox)")); return; }
	for (const m of msgs) {
		const ts = new Date(m.timestamp).toISOString();
		console.log(
			dim(ts.slice(11, 19)) + "  " +
			cyan(m.action.padEnd(14)) +
			"from " + dim(m.fromId.slice(0, 12)) +
			(m.payload ? "  " + m.payload.slice(0, 60) : ""),
		);
	}
}

async function cmdOutbox(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) { console.log(red("Usage: /outbox <id>")); return; }
	const id = await resolveId(raw);
	if (!id) { console.log(red("Not found: ") + raw); return; }
	const objActor = client.objectActor.getOrCreate([id]);
	const msgs = await objActor.getOutbox();
	if (msgs.length === 0) { console.log(dim("(empty outbox)")); return; }
	for (const m of msgs) {
		const ts = new Date(m.timestamp).toISOString();
		console.log(
			dim(ts.slice(11, 19)) + "  " +
			cyan(m.action.padEnd(14)) +
			"to " + dim(m.toId.slice(0, 12)) +
			(m.payload ? "  " + m.payload.slice(0, 60) : ""),
		);
	}
}

function summarizeOps(change: Change): string {
	const parts: string[] = [];
	for (const op of change.ops) {
		if (op.objectCreate) parts.push(`create(${op.objectCreate.typeKey})`);
		if (op.objectDelete) parts.push("delete");
		if (op.fieldSet) parts.push(`set(${op.fieldSet.key})`);
		if (op.fieldDelete) parts.push(`del(${op.fieldDelete.key})`);
		if (op.contentSet) parts.push(`content(${op.contentSet.content.byteLength}b)`);
		if (op.blockAdd) parts.push("block+");
		if (op.blockRemove) parts.push("block-");
		if (op.blockUpdate) parts.push("block~");
		if (op.blockMove) parts.push("blockmv");
	}
	return parts.join(", ") || "(no ops)";
}

async function cmdHistory(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) { console.log(red("Usage: /history <id>")); return; }
	// History reads from disk, but we still need the full id for filtering.
	// Try resolveId; if it fails, use raw as-is (might be a full UUID).
	const id = (await resolveId(raw)) ?? raw;
	const hexIds = listChangeFiles();
	const matches: Change[] = [];
	for (const hexId of hexIds) {
		const c = readChangeByHex(hexId);
		if (c && c.objectId === id) matches.push(c);
	}
	if (matches.length === 0) { console.log(dim("(no changes found)")); return; }
	matches.sort((a, b) => a.timestamp - b.timestamp);
	for (const c of matches) {
		const hex = hexEncode(c.id).slice(0, 12);
		const ts = new Date(c.timestamp).toISOString();
		console.log(dim(hex) + "  " + dim(ts.slice(0, 19)) + "  " + summarizeOps(c));
	}
	console.log(dim(`\n${matches.length} change(s)`));
}

function cmdChange(args: string[]): void {
	const hexId = args[0];
	if (!hexId) { console.log(red("Usage: /change <hex-id>")); return; }
	const c = readChangeByHex(hexId);
	if (!c) { console.log(red("Not found: ") + hexId); return; }
	console.log(bold("id:       ") + hexEncode(c.id));
	console.log(bold("objectId: ") + c.objectId);
	console.log(bold("time:     ") + new Date(c.timestamp).toISOString());
	console.log(bold("author:   ") + (c.author || dim("(none)")));
	if (c.parentIds.length > 0) {
		console.log(bold("parents:  ") + c.parentIds.map(p => hexEncode(p).slice(0, 12)).join(", "));
	} else {
		console.log(bold("parents:  ") + dim("(genesis)"));
	}
	console.log(bold("ops:"));
	for (const op of c.ops) {
		if (op.objectCreate) console.log("  create  type=" + cyan(op.objectCreate.typeKey));
		if (op.objectDelete) console.log("  " + red("delete"));
		if (op.fieldSet) console.log("  set     " + cyan(op.fieldSet.key) + "=" + displayValue(op.fieldSet.value));
		if (op.fieldDelete) console.log("  del     " + cyan(op.fieldDelete.key));
		if (op.contentSet) console.log("  content " + op.contentSet.content.byteLength + " bytes");
		if (op.blockAdd) console.log("  block+  " + op.blockAdd.block.id);
		if (op.blockRemove) console.log("  block-  " + op.blockRemove.blockId);
		if (op.blockUpdate) console.log("  block~  " + op.blockUpdate.blockId);
		if (op.blockMove) console.log("  blockmv " + op.blockMove.blockId);
	}
}

async function cmdInfo(): Promise<void> {
	const info = await store.info();
	console.log(bold("Objects: ") + String(info.totalObjects));
	console.log(bold("Changes: ") + String(info.totalChanges));
	if (Object.keys(info.byType).length > 0) {
		console.log(bold("By type:"));
		for (const [typeKey, cnt] of Object.entries(info.byType)) {
			console.log(`  ${cyan(typeKey.padEnd(14))} ${cnt}`);
		}
	}
}

function cmdDisk(): void {
	const stats = diskStats();
	console.log(bold("Path:    ") + stats.path);
	console.log(bold("Changes: ") + String(stats.changeCount));
	console.log(bold("Bytes:   ") + stats.totalBytes.toLocaleString());
}

// ── Sync protocol commands ────────────────────────────────────────

async function cmdHeads(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) { console.log(red("Usage: /heads <id>")); return; }
	const id = await resolveId(raw);
	if (!id) { console.log(red("Not found: ") + raw); return; }
	const actor = client.objectActor.getOrCreate([id]);
	const heads = await actor.getHeads();
	console.log(bold("Heads for ") + dim(id.slice(0, 12) + "..."));
	for (const h of heads) {
		console.log("  " + cyan(h.slice(0, 16)) + dim("..."));
	}
}

async function cmdChanges(args: string[]): Promise<void> {
	const raw = args[0];
	if (!raw) { console.log(red("Usage: /changes <id>")); return; }
	const id = await resolveId(raw);
	if (!id) { console.log(red("Not found: ") + raw); return; }
	const actor = client.objectActor.getOrCreate([id]);
	const csv = await actor.getAllChangeIds(id);
	const ids = csv.split(",").filter(Boolean);
	console.log(bold(`${ids.length} change(s)`) + " for " + dim(id.slice(0, 12) + "..."));
	for (const h of ids) {
		console.log("  " + dim(h.slice(0, 16)));
	}
}

/**
 * Sync two objects that share the same objectId on different actors.
 * In practice this demonstrates the sync protocol between two peers.
 * 
 * Usage: /sync <idA> <idB>
 * 
 * Both actors advertise their changes, compute the diff, and exchange
 * what each is missing.
 */
async function cmdSync(args: string[]): Promise<void> {
	const [rawA, rawB] = args;
	if (!rawA || !rawB) {
		console.log(red("Usage: /sync <objectA> <objectB>"));
		console.log(dim("  Syncs DAG state between two object actors."));
		return;
	}
	const idA = await resolveId(rawA);
	const idB = await resolveId(rawB);
	if (!idA) { console.log(red("Not found: ") + rawA); return; }
	if (!idB) { console.log(red("Not found: ") + rawB); return; }

	const actorA = client.objectActor.getOrCreate([idA]);
	const actorB = client.objectActor.getOrCreate([idB]);

	// Step 1: Gather all change IDs from both sides.
	const csvA = await actorA.getAllChangeIds(idA);
	const csvB = await actorB.getAllChangeIds(idB);
	const setA = new Set(csvA.split(",").filter(Boolean));
	const setB = new Set(csvB.split(",").filter(Boolean));

	console.log(dim(`  A has ${setA.size} changes, B has ${setB.size} changes`));

	// Step 2: Compute diff.
	const missingInA: string[] = []; // B has, A doesn't
	for (const id of setB) { if (!setA.has(id)) missingInA.push(id); }
	const missingInB: string[] = []; // A has, B doesn't
	for (const id of setA) { if (!setB.has(id)) missingInB.push(id); }

	if (missingInA.length === 0 && missingInB.length === 0) {
		console.log(green("  Already in sync."));
		return;
	}

	console.log(dim(`  A missing ${missingInA.length}, B missing ${missingInB.length}`));

	// Step 3: Exchange missing changes.
	if (missingInA.length > 0) {
		// Fetch from B, push to A.
		const changesB64 = await actorB.getChanges(missingInA.join(","));
		await actorA.pushChanges(changesB64);
		console.log(green(`  Pushed ${missingInA.length} change(s) to A`));
	}
	if (missingInB.length > 0) {
		// Fetch from A, push to B.
		const changesB64 = await actorA.getChanges(missingInB.join(","));
		await actorB.pushChanges(changesB64);
		console.log(green(`  Pushed ${missingInB.length} change(s) to B`));
	}

	// Step 4: Verify.
	const newHeadsA = await actorA.getHeads();
	const newHeadsB = await actorB.getHeads();
	console.log(dim(`  A heads: ${newHeadsA.map((h: string) => h.slice(0, 12)).join(", ")}`));
	console.log(dim(`  B heads: ${newHeadsB.map((h: string) => h.slice(0, 12)).join(", ")}`));
	console.log(green("  Sync complete."));
}

// ── Tic-Tac-Toe commands ───────────────────────────────────────────

async function cmdTtt(args: string[]): Promise<void> {
	const sub = args[0];
	const rest = args.slice(1);

	switch (sub) {
		case "new": {
			const name = rest.join(" ") || "tic-tac-toe";
			const fields = newGameFields();
			fields["name"] = stringVal(name);
			const fieldsJson = JSON.stringify(fields);
			const id = await store.create("game", fieldsJson);
			console.log(green("New game: ") + bold(id));
			console.log(dim("  Use /ttt board " + id.slice(0, 8) + " to see the board"));
			console.log(dim("  Use /ttt move " + id.slice(0, 8) + " <0-8> to play"));
			break;
		}

		case "board": {
			const raw = rest[0];
			if (!raw) { console.log(red("Usage: /ttt board <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { console.log(red("Not found: ") + raw); break; }
			const state = await store.get(id);
			if (!state) { console.log(red("Not found")); break; }
			const board = readBoard(state.fields as Record<string, any>);
			console.log(renderBoard(board));
			break;
		}

		case "move": {
			const raw = rest[0];
			const posStr = rest[1];
			if (!raw || posStr === undefined) {
				console.log(red("Usage: /ttt move <id> <position 0-8>"));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { console.log(red("Not found: ") + raw); break; }
			const pos = parseInt(posStr, 10);
			if (isNaN(pos)) { console.log(red("Position must be 0-8")); break; }

			// Read current state from the actor.
			const state = await store.get(id);
			if (!state) { console.log(red("Not found")); break; }
			const board = readBoard(state.fields as Record<string, any>);

			// Validate and compute the move.
			const result = computeMove(board, pos);
			if (!result.ok) {
				console.log(red("  " + result.error));
				break;
			}

			// Apply: set each field as a change on the object actor.
			const actor = client.objectActor.getOrCreate([id]);
			for (const [key, value] of Object.entries(result.fields)) {
				await actor.setField(key, JSON.stringify(value));
			}

			// Re-read and render.
			const updated = await store.get(id);
			if (updated) {
				const newBoard = readBoard(updated.fields as Record<string, any>);
				console.log(renderBoard(newBoard));
			}
			break;
		}

		case "history": {
			const raw = rest[0];
			if (!raw) { console.log(red("Usage: /ttt history <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { console.log(red("Not found: ") + raw); break; }
			console.log(renderMoveHistory(id));
			break;
		}

		default:
			console.log([
				bold("  Tic-Tac-Toe"),
				`    ${cyan("/ttt new")} ${dim("[name]")}           start a new game`,
				`    ${cyan("/ttt board")} ${dim("<id>")}            show the board`,
				`    ${cyan("/ttt move")} ${dim("<id> <0-8>")}      make a move`,
				`    ${cyan("/ttt history")} ${dim("<id>")}          move-by-move replay`,
				"",
				`  ${dim("Positions:")}`,
				`    ${dim("0")}|${dim("1")}|${dim("2")}`,
				`    ${dim("-+-+-")}`,
				`    ${dim("3")}|${dim("4")}|${dim("5")}`,
				`    ${dim("-+-+-")}`,
				`    ${dim("6")}|${dim("7")}|${dim("8")}`,
				"",
				`  ${dim("Every move is a content-addressed Change in the DAG.")}`,
				`  ${dim("Use /history <id> to see the full change log.")}`,
			].join("\n"));
	}
}

function cmdHelp(): void {
	const cmds = [
		["/create <type> [name]", "Create a new object"],
		["/list [type]", "List objects (optionally filter by type)"],
		["/get <id>", "Show full object state"],
		["/set <id> <key> <value>", "Set a field on an object"],
		["/delete <id>", "Delete an object"],
		["/search <query>", "Search objects by ID substring"],
		["/send <from> <to> <action> [payload]", "Send IPC message"],
		["/inbox <id>", "Show object inbox"],
		["/outbox <id>", "Show object outbox"],
		["/history <id>", "Show change history for an object"],
		["/change <hex-id>", "Inspect a single change"],
		["/heads <id>", "Show DAG head change IDs"],
		["/changes <id>", "List all change IDs for an object"],
		["/sync <idA> <idB>", "Sync DAG state between two objects"],
		["/ttt new|board|move|history", "Tic-Tac-Toe (try /ttt for help)"],
		["/info", "Store summary"],
		["/disk", "Disk usage stats"],
		["/help", "This help"],
		["/quit", "Exit"],
	];
	for (const [cmd, desc] of cmds) {
		console.log(`  ${cyan(cmd.padEnd(42))} ${dim(desc)}`);
	}
}

// ── REPL ─────────────────────────────────────────────────────────

async function dispatch(line: string): Promise<boolean> {
	const trimmed = line.trim();
	if (!trimmed) return true;
	if (!trimmed.startsWith("/")) {
		console.log(dim("Commands start with /. Type /help."));
		return true;
	}

	const [cmd, ...args] = trimmed.split(/\s+/);

	try {
		switch (cmd) {
			case "/create": await cmdCreate(args); break;
			case "/list": await cmdList(args); break;
			case "/get": await cmdGet(args); break;
			case "/set": await cmdSet(args); break;
			case "/delete": await cmdDelete(args); break;
			case "/search": await cmdSearch(args); break;
			case "/send": await cmdSend(args); break;
			case "/inbox": await cmdInbox(args); break;
			case "/outbox": await cmdOutbox(args); break;
			case "/history": await cmdHistory(args); break;
			case "/change": cmdChange(args); break;
			case "/heads": await cmdHeads(args); break;
			case "/changes": await cmdChanges(args); break;
			case "/sync": await cmdSync(args); break;
			case "/ttt": await cmdTtt(args); break;
			case "/info": await cmdInfo(); break;
			case "/disk": cmdDisk(); break;
			case "/help": cmdHelp(); break;
			case "/quit":
			case "/exit":
			case "/q":
				return false;
			default:
				console.log(red(`Unknown command: ${cmd}`) + "  " + dim("Try /help"));
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(red("Error: ") + msg);
	}

	return true;
}

async function main() {
	console.log(bold("Glon OS") + dim(` — ${ENDPOINT}`));
	console.log(dim("Type /help for commands.\n"));

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: `${CYAN}glon>${RESET} `,
	});

	// Queue commands so async handlers don't race with readline close.
	let pending: Promise<void> = Promise.resolve();
	let alive = true;

	rl.prompt();

	rl.on("line", (line: string) => {
		pending = pending.then(async () => {
			if (!alive) return;
			const keepGoing = await dispatch(line);
			if (!keepGoing) {
				alive = false;
				rl.close();
				return;
			}
			if (alive) rl.prompt();
		});
	});

	rl.on("close", () => {
		pending.then(() => {
			console.log(dim("\nBye."));
			process.exit(0);
		});
	});
}

main().catch((err) => {
	console.error("Client failed:", err);
	process.exit(1);
});
