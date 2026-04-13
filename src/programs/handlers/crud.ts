/**
 * CRUD operations program — basic object management.
 *
 * Provides fundamental operations for creating, reading, updating, and
 * deleting objects in the Glon DAG. These were previously built into
 * the shell but are now just another program.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";

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

/** Parse a user-supplied string into a proto Value. */
function parseValue(raw: string, ctx: ProgramContext) {
	if (raw === "true") return ctx.boolVal(true);
	if (raw === "false") return ctx.boolVal(false);
	const n = Number(raw);
	if (!Number.isNaN(n) && raw.trim() !== "") {
		return Number.isInteger(n) ? ctx.intVal(n) : ctx.floatVal(n);
	}
	return ctx.stringVal(raw);
}

async function cmdCreate(args: string[], ctx: ProgramContext): Promise<void> {
	const [typeKey, ...rest] = args;
	if (!typeKey) {
		ctx.print(red("Usage: /crud create <type> [name]"));
		return;
	}
	const name = rest.join(" ");
	let fieldsJson = "{}";
	if (name) {
		fieldsJson = JSON.stringify({ name: ctx.stringVal(name) });
	}
	const id = await ctx.store.create(typeKey, fieldsJson);
	ctx.print(green("Created: ") + id);
}

async function cmdList(args: string[], ctx: ProgramContext): Promise<void> {
	const typeKey = args[0] || undefined;
	const refs = await ctx.store.list(typeKey);
	if (refs.length === 0) {
		ctx.print(dim("(no objects)"));
		return;
	}
	for (const r of refs) {
		const shortId = r.id.length > 12 ? r.id.slice(0, 12) + "..." : r.id;
		ctx.print(cyan(r.typeKey.padEnd(14)) + dim(shortId));
	}
	ctx.print(dim(`\n${refs.length} object(s)`));
}

async function cmdGet(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /crud get <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const obj = await ctx.store.get(id);
	if (!obj) {
		ctx.print(red("Not found: ") + id);
		return;
	}

	ctx.print(bold("id:       ") + obj.id);
	ctx.print(bold("type:     ") + cyan(obj.typeKey));
	ctx.print(bold("created:  ") + new Date(obj.createdAt).toISOString());
	ctx.print(bold("updated:  ") + new Date(obj.updatedAt).toISOString());
	if (obj.deleted) {
		ctx.print(bold("deleted:  ") + red("true"));
	}

	// Fields
	if (obj.fields && Object.keys(obj.fields).length > 0) {
		ctx.print(bold("fields:"));
		for (const [key, value] of Object.entries(obj.fields)) {
			const display = ctx.displayValue(value);
			ctx.print("  " + cyan(key) + " = " + display);
		}
	}

	// Content
	if (obj.contentBase64) {
		const bytes = Buffer.from(obj.contentBase64, "base64");
		ctx.print(bold("content:  ") + bytes.byteLength + " bytes");
		if (bytes.byteLength <= 200) {
			const text = bytes.toString("utf-8");
			ctx.print(dim("  " + text.slice(0, 200)));
		}
	}

	// Blocks (simplified)
	if (obj.blocks && obj.blocks.length > 0) {
		ctx.print(bold("blocks:   ") + obj.blocks.length);
	}

	// DAG info
	ctx.print(bold("changes:  ") + obj.changeCount);
	if (obj.headIds && obj.headIds.length > 0) {
		ctx.print(bold("heads:    ") + obj.headIds.map(h => h.slice(0, 12)).join(", "));
	}
}

async function cmdSet(args: string[], ctx: ProgramContext): Promise<void> {
	const [rawId, key, ...rest] = args;
	if (!rawId || !key) {
		ctx.print(red("Usage: /crud set <id> <key> <value>"));
		return;
	}
	const value = rest.join(" ");
	const id = await ctx.resolveId(rawId);
	if (!id) {
		ctx.print(red("Not found: ") + rawId);
		return;
	}
	const objActor = ctx.objectActor(id);
	const protoValue = parseValue(value, ctx);
	await objActor.setField(key, JSON.stringify(protoValue));
	ctx.print(green("OK"));
}

async function cmdDelete(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /crud delete <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const ok = await ctx.store.delete(id);
	if (ok) {
		ctx.print(green("Deleted: ") + id);
	} else {
		ctx.print(red("Not found: ") + id);
	}
}

async function cmdSearch(args: string[], ctx: ProgramContext): Promise<void> {
	const query = args.join(" ");
	if (!query) {
		ctx.print(red("Usage: /crud search <query>"));
		return;
	}
	const refs = await ctx.store.search(query);
	if (refs.length === 0) {
		ctx.print(dim("(no matches)"));
		return;
	}
	for (const r of refs) {
		const shortId = r.id.length > 12 ? r.id.slice(0, 12) + "..." : r.id;
		ctx.print(cyan(r.typeKey.padEnd(14)) + dim(shortId.padEnd(40)) + new Date(r.updatedAt).toISOString().slice(0, 19));
	}
	ctx.print(dim(`\n${refs.length} match(es)`));
}

const programDef: ProgramDef = {
	handler: async (cmd: string, args: string[], ctx: ProgramContext) => {
		switch (cmd) {
			case "create": await cmdCreate(args, ctx); break;
			case "list": await cmdList(args, ctx); break;
			case "get": await cmdGet(args, ctx); break;
			case "set": await cmdSet(args, ctx); break;
			case "delete": await cmdDelete(args, ctx); break;
			case "search": await cmdSearch(args, ctx); break;
			default:
				ctx.print(`Unknown command: ${cmd}`);
				ctx.print("Commands: create, list, get, set, delete, search");
		}
	},
};

export default programDef;