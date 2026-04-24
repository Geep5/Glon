/**
 * DAG inspection program — low-level Change DAG operations.
 *
 * Provides direct access to the change history, DAG structure, heads,
 * and raw protobuf changes stored on disk. For debugging and
 * understanding the content-addressed DAG.
 */

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import type { Change } from "../../proto.js";

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

async function cmdHistory(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /inspect history <id>"));
		return;
	}
	const id = (await ctx.resolveId(raw)) ?? raw;
	const hexIds = ctx.listChangeFiles();
	const matches: Change[] = [];
	for (const hexId of hexIds) {
		const c = ctx.readChangeByHex(hexId);
		if (c && c.objectId === id) matches.push(c);
	}
	if (matches.length === 0) {
		ctx.print(dim("(no changes found)"));
		return;
	}
	matches.sort((a, b) => a.timestamp - b.timestamp);
	for (const c of matches) {
		const hex = ctx.hexEncode(c.id).slice(0, 12);
		const ts = new Date(c.timestamp).toISOString();
		ctx.print(dim(hex) + "  " + dim(ts.slice(0, 19)) + "  " + summarizeOps(c));
	}
	ctx.print(dim(`\n${matches.length} change(s)`));
}

function cmdChange(args: string[], ctx: ProgramContext): void {
	const hexId = args[0];
	if (!hexId) {
		ctx.print(red("Usage: /inspect change <hex-id>"));
		return;
	}
	const c = ctx.readChangeByHex(hexId);
	if (!c) {
		ctx.print(red("Not found: ") + hexId);
		return;
	}
	ctx.print(bold("id:       ") + ctx.hexEncode(c.id));
	ctx.print(bold("objectId: ") + c.objectId);
	ctx.print(bold("time:     ") + new Date(c.timestamp).toISOString());
	ctx.print(bold("author:   ") + (c.author || dim("(none)")));
	if (c.parentIds.length > 0) {
		ctx.print(bold("parents:  ") + c.parentIds.map(p => ctx.hexEncode(p).slice(0, 12)).join(", "));
	} else {
		ctx.print(bold("parents:  ") + dim("(genesis)"));
	}
	ctx.print(bold("ops:"));
	for (const op of c.ops) {
		if (op.objectCreate) ctx.print("  create  type=" + cyan(op.objectCreate.typeKey));
		if (op.objectDelete) ctx.print("  " + red("delete"));
		if (op.fieldSet) ctx.print("  set     " + cyan(op.fieldSet.key) + "=" + ctx.displayValue(op.fieldSet.value));
		if (op.fieldDelete) ctx.print("  del     " + cyan(op.fieldDelete.key));
		if (op.contentSet) ctx.print("  content " + op.contentSet.content.byteLength + " bytes");
		if (op.blockAdd) ctx.print("  block+  " + op.blockAdd.block.id);
		if (op.blockRemove) ctx.print("  block-  " + op.blockRemove.blockId);
		if (op.blockUpdate) ctx.print("  block~  " + op.blockUpdate.blockId);
		if (op.blockMove) ctx.print("  blockmv " + op.blockMove.blockId);
	}
}

async function cmdHeads(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /inspect heads <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);
	const vars = await objActor.getVars();
	if (!vars.headIds || vars.headIds.length === 0) {
		ctx.print(dim("(no heads)"));
		return;
	}
	ctx.print(bold("Current heads:"));
	for (const h of vars.headIds) {
		ctx.print("  " + cyan(h));
	}
}

async function cmdChanges(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /inspect changes <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);
	const changeIds = await objActor.getAllChangeIds();
	if (changeIds.length === 0) {
		ctx.print(dim("(no changes)"));
		return;
	}
	ctx.print(bold(`${changeIds.length} change(s):`));
	for (const cid of changeIds) {
		const hex = ctx.hexEncode(cid);
		ctx.print("  " + dim(hex));
	}
}

async function cmdSnapshot(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /inspect snapshot <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);
	const snapId = await objActor.snapshot();
	ctx.print(green("Snapshot created: ") + ctx.hexEncode(snapId).slice(0, 12));
}

async function cmdSync(args: string[], ctx: ProgramContext): Promise<void> {
	const [rawA, rawB] = args;
	if (!rawA || !rawB) {
		ctx.print(red("Usage: /inspect sync <idA> <idB>"));
		return;
	}
	const idA = await ctx.resolveId(rawA);
	const idB = await ctx.resolveId(rawB);
	if (!idA) { ctx.print(red("Not found: ") + rawA); return; }
	if (!idB) { ctx.print(red("Not found: ") + rawB); return; }

	const actorA = ctx.objectActor(idA);
	const actorB = ctx.objectActor(idB);

	// Get all changes from both
	const changesA = await actorA.getAllChangeIds();
	const changesB = await actorB.getAllChangeIds();

	ctx.print(dim(`A has ${changesA.length} changes, B has ${changesB.length} changes`));

	// Find what each is missing
	const setA = new Set(changesA.map(c => ctx.hexEncode(c)));
	const setB = new Set(changesB.map(c => ctx.hexEncode(c)));

	const missingInB = [...setA].filter(h => !setB.has(h));
	const missingInA = [...setB].filter(h => !setA.has(h));

	ctx.print(dim(`A missing ${missingInA.length}, B missing ${missingInB.length}`));

	// Actually sync
	await actorA.syncWith(idB);

	ctx.print(green("Synced"));
}

async function cmdRemote(args: string[], ctx: ProgramContext): Promise<void> {
	const [action, endpoint, rawId] = args;
	if (!action || !endpoint || !rawId) {
		ctx.print(red("Usage: /inspect remote push|pull <endpoint> <id>"));
		return;
	}

	const id = await ctx.resolveId(rawId);
	if (!id) {
		ctx.print(red("Not found: ") + rawId);
		return;
	}

	const objActor = ctx.objectActor(id);

	if (action === "push") {
		await objActor.pushToRemote(endpoint);
		ctx.print(green("Pushed to ") + endpoint);
	} else if (action === "pull") {
		await objActor.pullFromRemote(endpoint);
		ctx.print(green("Pulled from ") + endpoint);
	} else {
		ctx.print(red("Unknown action: ") + action + " (use push or pull)");
	}
}

async function cmdInfo(_args: string[], ctx: ProgramContext): Promise<void> {
	const info = await ctx.store.info();
	ctx.print(bold("Store Info"));
	ctx.print("  " + cyan("Total objects:  ") + info.totalObjects);
	ctx.print("  " + cyan("Total changes:  ") + info.totalChanges);
	ctx.print("");
	ctx.print(bold("Objects by type:"));
	for (const [typeKey, cnt] of Object.entries(info.byType)) {
		ctx.print("  " + cyan(typeKey.padEnd(14)) + cnt);
	}
}

async function cmdDisk(_args: string[], ctx: ProgramContext): Promise<void> {
	const { diskStats } = await import("../../disk.js");
	const stats = diskStats();
	ctx.print(bold("Disk Usage"));
	ctx.print("  " + cyan("Changes:  ") + stats.changeCount);
	ctx.print("  " + cyan("Size:     ") + (stats.totalBytes / 1024 / 1024).toFixed(2) + " MB");
	ctx.print("  " + cyan("Path:     ") + stats.path);
}

// ── Shared helpers for actor actions ────────────────────────────────

function asObj(input: unknown): Record<string, any> {
	if (input && typeof input === "object" && !Array.isArray(input)) return input as any;
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { /* fall through */ }
	}
	return {};
}

function opSummaryStruct(op: any): Record<string, unknown> {
	if (op.objectCreate) return { type: "objectCreate", type_key: op.objectCreate.typeKey };
	if (op.objectDelete) return { type: "objectDelete" };
	if (op.fieldSet) return { type: "fieldSet", key: op.fieldSet.key };
	if (op.fieldDelete) return { type: "fieldDelete", key: op.fieldDelete.key };
	if (op.contentSet) return { type: "contentSet", bytes: op.contentSet.content?.byteLength ?? 0 };
	if (op.blockAdd) return { type: "blockAdd", block_id: op.blockAdd.block?.id };
	if (op.blockRemove) return { type: "blockRemove", block_id: op.blockRemove.blockId };
	if (op.blockUpdate) return { type: "blockUpdate", block_id: op.blockUpdate.blockId };
	if (op.blockMove) return { type: "blockMove", block_id: op.blockMove.blockId };
	return { type: "unknown" };
}

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		history: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = typeof input === "string" ? input : (o.object_id ?? o.id);
			if (!object_id || typeof object_id !== "string") throw new Error("history: object_id required");
			const limit = typeof o.limit === "number" && o.limit > 0 ? o.limit : 100;
			const hexIds = ctx.listChangeFiles();
			const matches: Change[] = [];
			for (const hex of hexIds) {
				const c = ctx.readChangeByHex(hex);
				if (c && c.objectId === object_id) matches.push(c);
			}
			matches.sort((a, b) => a.timestamp - b.timestamp);
			const sliced = matches.slice(-limit);
			return {
				total: matches.length,
				changes: sliced.map((c) => ({
					hex_id: ctx.hexEncode(c.id),
					timestamp: c.timestamp,
					author: c.author || null,
					parent_hex_ids: c.parentIds.map((p) => ctx.hexEncode(p)),
					op_summary: summarizeOps(c),
					ops: c.ops.map(opSummaryStruct),
				})),
			};
		},

		heads: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = typeof input === "string" ? input : (o.object_id ?? o.id);
			if (!object_id || typeof object_id !== "string") throw new Error("heads: object_id required");
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			const state = await actor.read();
			return { head_ids: state.headIds ?? [] };
		},

		changeDetail: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const hex_id = typeof input === "string" ? input : (o.hex_id ?? o.id);
			if (!hex_id || typeof hex_id !== "string") throw new Error("changeDetail: hex_id required");
			const c = ctx.readChangeByHex(hex_id);
			if (!c) return null;
			return {
				hex_id: ctx.hexEncode(c.id),
				object_id: c.objectId,
				timestamp: c.timestamp,
				author: c.author || null,
				parent_hex_ids: c.parentIds.map((p) => ctx.hexEncode(p)),
				ops: c.ops.map(opSummaryStruct),
			};
		},
	},
};

const programDef: ProgramDef = {
	handler: async (cmd: string, args: string[], ctx: ProgramContext) => {
		switch (cmd) {
			case "history": await cmdHistory(args, ctx); break;
			case "change": cmdChange(args, ctx); break;
			case "heads": await cmdHeads(args, ctx); break;
			case "changes": await cmdChanges(args, ctx); break;
			case "snapshot": await cmdSnapshot(args, ctx); break;
			case "sync": await cmdSync(args, ctx); break;
			case "remote": await cmdRemote(args, ctx); break;
			case "info": await cmdInfo(args, ctx); break;
			case "disk": await cmdDisk(args, ctx); break;
			default:
				ctx.print(`Unknown command: ${cmd}`);
				ctx.print("Commands: history, change, heads, changes, snapshot, sync, remote, info, disk");
		}
	},
	actor: actorDef,
};

export default programDef;