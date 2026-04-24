/**
 * CRUD operations program — basic object management.
 *
 * Provides fundamental operations for creating, reading, updating, and
 * deleting objects in the Glon DAG. These were previously built into
 * the shell but are now just another program.
 */

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import type { Value } from "../../proto.js";

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

async function findTypeDef(typeKey: string, ctx: ProgramContext) {
	const refs = await ctx.store.list("type");
	for (const r of refs) {
		const obj = await ctx.store.get(r.id);
		if (obj?.fields?.key?.stringValue === typeKey) return obj;
	}
	return null;
}

async function cmdType(args: string[], ctx: ProgramContext): Promise<void> {
	const sub = args[0];
	switch (sub) {
		case "create": {
			const name = args.slice(1).join(" ");
			if (!name) { ctx.print(red("Usage: /crud type create <name>")); return; }
			const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
			const fieldsJson = JSON.stringify({
				name: ctx.stringVal(name),
				key: ctx.stringVal(key),
				properties: ctx.listVal([]),
			});
			const id = await ctx.store.create("type", fieldsJson);
			ctx.print(green("Created type: ") + cyan(name) + dim(" (key: " + key + ")"));
			ctx.print(dim("  id: " + id));
			break;
		}
		case "list": {
			const refs = await ctx.store.list("type");
			if (refs.length === 0) { ctx.print(dim("(no type definitions)")); return; }
			for (const r of refs) {
				const obj = await ctx.store.get(r.id);
				const name = obj?.fields?.name?.stringValue || "?";
				const key = obj?.fields?.key?.stringValue || "?";
				ctx.print(cyan(key.padEnd(16)) + name + dim("  " + r.id.slice(0, 12) + "..."));
			}
			break;
		}
		case "get": {
			const key = args[1];
			if (!key) { ctx.print(red("Usage: /crud type get <key>")); return; }
			const typeDef = await findTypeDef(key, ctx);
			if (!typeDef) { ctx.print(red("Type not found: ") + key); return; }
			ctx.print(bold("name: ") + typeDef.fields.name?.stringValue);
			ctx.print(bold("key:  ") + typeDef.fields.key?.stringValue);
			const props = typeDef.fields.properties?.valuesValue?.items || [];
			if (props.length === 0) {
				ctx.print(dim("  (no properties)"));
			} else {
				ctx.print(bold("properties:"));
				for (const p of props) {
					const e = p.mapValue?.entries || {};
					const pName = e.name?.stringValue || "?";
					const pKey = e.key?.stringValue || "?";
					const pFmt = e.format?.stringValue || "?";
					ctx.print("  " + cyan(pKey.padEnd(16)) + pFmt.padEnd(12) + dim(pName));
				}
			}
			break;
		}
		case "add-prop": {
			const typeKey = args[1];
			const propName = args[2];
			const format = args[3];
			const FORMATS = ["text", "number", "date", "select", "object", "checkbox", "url", "email"];
			if (!typeKey || !propName || !format) {
				ctx.print(red("Usage: /crud type add-prop <type-key> <prop-name> <format>"));
				ctx.print(dim("  Formats: " + FORMATS.join(", ")));
				return;
			}
			if (!FORMATS.includes(format)) {
				ctx.print(red("Invalid format: ") + format);
				ctx.print(dim("  Valid: " + FORMATS.join(", ")));
				return;
			}
			const typeDef = await findTypeDef(typeKey, ctx);
			if (!typeDef) { ctx.print(red("Type not found: ") + typeKey); return; }
			const propKey = propName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
			const existing = typeDef.fields.properties?.valuesValue?.items || [];
			const newProp = ctx.mapVal({
				name: ctx.stringVal(propName),
				key: ctx.stringVal(propKey),
				format: ctx.stringVal(format),
			});
			const updated = ctx.listVal([...existing, newProp]);
			const actor = ctx.objectActor(typeDef.id);
			await actor.setField("properties", JSON.stringify(updated));
			ctx.print(green("Added property: ") + cyan(propKey) + dim(" (" + format + ")"));
			break;
		}
		default:
			ctx.print("Type commands: create, list, get, add-prop");
	}
}

// ── Shared helpers for actor actions ────────────────────────────────

function asObj(input: unknown): Record<string, any> {
	if (input && typeof input === "object" && !Array.isArray(input)) return input as any;
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { /* fall through */ }
	}
	return {};
}

/** Coerce a primitive or pre-built Value into a proto Value. */
function coerceToValue(raw: unknown, ctx: ProgramContext): Value {
	if (raw == null) throw new Error("value cannot be null/undefined");
	if (typeof raw === "string") return ctx.stringVal(raw);
	if (typeof raw === "number") return Number.isInteger(raw) ? ctx.intVal(raw) : ctx.floatVal(raw);
	if (typeof raw === "boolean") return ctx.boolVal(raw);
	if (typeof raw === "object") return raw as Value;
	throw new Error(`cannot coerce ${typeof raw} to Value`);
}

/** Accept either a bare id string or {object_id} object. */
function resolveIdArg(input: unknown): string {
	if (typeof input === "string") return input;
	const o = asObj(input);
	const id = o.object_id ?? o.id;
	if (typeof id !== "string" || !id) throw new Error("object_id required");
	return id;
}

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		// ── Read ─────────────────────────────────────────────

		list: async (ctx: ProgramContext, input?: unknown) => {
			const o = asObj(input);
			const type_key = typeof o.type_key === "string" ? o.type_key : undefined;
			const limit = typeof o.limit === "number" && o.limit > 0 ? o.limit : 100;
			const store = ctx.store as any;
			const refs = await store.list(type_key) as Array<{ id: string; typeKey: string; createdAt?: number; updatedAt?: number }>;
			const sliced = refs.slice(0, limit);
			// Enrich with common summary fields (name, prefix) so callers can find things without N+1 get calls.
			const enriched = await Promise.all(sliced.map(async (r) => {
				try {
					const obj = await store.get(r.id);
					const f = obj?.fields ?? {};
					const extract = (v: any) => v?.stringValue ?? (typeof v === "string" ? v : undefined);
					return {
						id: r.id,
						typeKey: r.typeKey,
						name: extract(f.name),
						prefix: extract(f.prefix),
						path: extract(f.path),
						display_name: extract(f.display_name),
						deleted: !!obj?.deleted,
					};
				} catch {
					return { id: r.id, typeKey: r.typeKey };
				}
			}));
			return { objects: enriched, total: refs.length };
		},

		get: async (ctx: ProgramContext, input: unknown) => {
			const id = resolveIdArg(input);
			const obj = await (ctx.store as any).get(id);
			if (!obj) return null;
			return {
				id: obj.id,
				typeKey: obj.typeKey,
				fields: obj.fields,
				blockCount: obj.blocks?.length ?? 0,
				contentBytes: obj.content ? Buffer.from(obj.content, "base64").byteLength : 0,
				deleted: !!obj.deleted,
				createdAt: obj.createdAt,
				updatedAt: obj.updatedAt,
				changeCount: obj.changeCount,
				headIds: obj.headIds,
			};
		},

		readContent: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const id = typeof input === "string" ? input : (o.object_id ?? o.id);
			if (!id || typeof id !== "string") throw new Error("readContent: object_id required");
			const max_bytes = typeof o.max_bytes === "number" ? Math.min(o.max_bytes, 65536) : 16384;
			const actor = (ctx.client as any).objectActor.getOrCreate([id]);
			const text: string = await actor.readContent();
			if (!text) return { content: "", truncated: false, full_bytes: 0 };
			if (text.length <= max_bytes) return { content: text, truncated: false, full_bytes: text.length };
			return {
				content: text.slice(0, max_bytes) + `\n…[truncated, ${text.length - max_bytes} more bytes]`,
				truncated: true,
				full_bytes: text.length,
			};
		},

		search: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const query = typeof input === "string" ? input : o.query;
			if (!query || typeof query !== "string") throw new Error("search: query required");
			const type_key = typeof o.type_key === "string" ? o.type_key : undefined;
			const limit = typeof o.limit === "number" && o.limit > 0 ? o.limit : 20;
			const refs = await (ctx.store as any).search(query) as Array<{ id: string; typeKey: string; createdAt?: number; updatedAt?: number }>;
			const filtered = type_key ? refs.filter((r) => r.typeKey === type_key) : refs;
			return { matches: filtered.slice(0, limit), total: filtered.length };
		},

		// ── Write ─────────────────────────────────────────────

		create: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const type_key = o.type_key;
			if (!type_key || typeof type_key !== "string") throw new Error("create: type_key required");
			let fieldsJson: string | undefined;
			if (o.fields && typeof o.fields === "object") {
				const coerced: Record<string, Value> = {};
				for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
					coerced[k] = coerceToValue(v, ctx);
				}
				fieldsJson = JSON.stringify(coerced);
			}
			let contentBase64: string | undefined;
			if (typeof o.content === "string") {
				contentBase64 = Buffer.from(o.content, "utf-8").toString("base64");
			} else if (o.content_base64 && typeof o.content_base64 === "string") {
				contentBase64 = o.content_base64;
			}
			const id = await (ctx.store as any).create(type_key, fieldsJson, contentBase64);
			return { id, type_key };
		},

		setField: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = o.object_id;
			const key = o.key;
			if (!object_id || typeof object_id !== "string") throw new Error("setField: object_id required");
			if (!key || typeof key !== "string") throw new Error("setField: key required");
			const value = coerceToValue(o.value, ctx);
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			await actor.setField(key, JSON.stringify(value));
			return { ok: true, object_id, key };
		},

		setFields: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = o.object_id;
			if (!object_id || typeof object_id !== "string") throw new Error("setFields: object_id required");
			if (!o.fields || typeof o.fields !== "object") throw new Error("setFields: fields object required");
			const coerced: Record<string, Value> = {};
			for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
				coerced[k] = coerceToValue(v, ctx);
			}
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			await actor.setFields(JSON.stringify(coerced));
			return { ok: true, object_id, keys: Object.keys(coerced) };
		},

		deleteField: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = o.object_id;
			const key = o.key;
			if (!object_id || typeof object_id !== "string") throw new Error("deleteField: object_id required");
			if (!key || typeof key !== "string") throw new Error("deleteField: key required");
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			await actor.deleteField(key);
			return { ok: true, object_id, key };
		},

		setContent: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = o.object_id;
			if (!object_id || typeof object_id !== "string") throw new Error("setContent: object_id required");
			let base64: string;
			if (typeof o.content === "string") {
				base64 = Buffer.from(o.content, "utf-8").toString("base64");
			} else if (typeof o.content_base64 === "string") {
				base64 = o.content_base64;
			} else {
				throw new Error("setContent: content (utf-8 string) or content_base64 required");
			}
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			await actor.setContent(base64);
			return { ok: true, object_id, bytes: Buffer.from(base64, "base64").byteLength };
		},

		remove: async (ctx: ProgramContext, input: unknown) => {
			const id = resolveIdArg(input);
			const actor = (ctx.client as any).objectActor.getOrCreate([id]);
			await actor.markDeleted();
			return { ok: true, object_id: id };
		},

		addBlock: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const object_id = o.object_id;
			if (!object_id || typeof object_id !== "string") throw new Error("addBlock: object_id required");
			if (!o.block || typeof o.block !== "object") throw new Error("addBlock: block object required");
			const actor = (ctx.client as any).objectActor.getOrCreate([object_id]);
			await actor.addBlock(JSON.stringify(o.block));
			return { ok: true, object_id };
		},
	},
};

const programDef: ProgramDef = {
	handler: async (cmd: string, args: string[], ctx: ProgramContext) => {
		switch (cmd) {
			case "create": await cmdCreate(args, ctx); break;
			case "list": await cmdList(args, ctx); break;
			case "get": await cmdGet(args, ctx); break;
			case "set": await cmdSet(args, ctx); break;
			case "delete": await cmdDelete(args, ctx); break;
			case "search": await cmdSearch(args, ctx); break;
			case "type": await cmdType(args, ctx); break;
			default:
				ctx.print(`Unknown command: ${cmd}`);
				ctx.print("Commands: create, list, get, set, delete, search, type");
		}
	},
	actor: actorDef,
};

export default programDef;