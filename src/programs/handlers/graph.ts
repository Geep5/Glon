import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }

function short(id: string): string {
	return id.length > 12 ? id.slice(0, 12) + "..." : id;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { store, resolveId, print } = ctx as any;

	switch (cmd) {
		case "links": {
			const rawId = args[0];
			if (!rawId) { print(red("Usage: /graph links <id>")); return; }
			const id = await resolveId(rawId);
			if (!id) { print(red("Not found: ") + rawId); return; }

			const outbound = await store.getLinks(id);
			const inbound = await store.getBacklinks(id);

			if (outbound.length === 0 && inbound.length === 0) {
				print(dim("(no links)"));
				return;
			}

			if (outbound.length > 0) {
				print(bold("outbound:"));
				for (const l of outbound) {
					print(`  ${cyan(l.relationKey.padEnd(16))} \u2192 ${short(l.targetId)}`);
				}
			}
			if (inbound.length > 0) {
				print(bold("inbound:"));
				for (const l of inbound) {
					print(`  ${cyan(l.relationKey.padEnd(16))} \u2190 ${short(l.sourceId)}`);
				}
			}
			break;
		}

		case "traverse": {
			const rawId = args[0];
			const depth = parseInt(args[1] || "2", 10);
			if (!rawId) { print(red("Usage: /graph traverse <id> [depth]")); return; }
			const id = await resolveId(rawId);
			if (!id) { print(red("Not found: ") + rawId); return; }

			const nodes = await store.graphQuery(id, depth);
			if (nodes.length === 0) { print(dim("(no results)")); return; }

			for (const node of nodes) {
				const indent = "  ".repeat(node.depth);
				const ref = await store.getRef(node.id);
				const obj = ref ? await store.get(node.id) : null;
				const name = obj?.fields?.name?.stringValue || "";
				print(`${indent}${cyan(node.typeKey)} ${short(node.id)}${name ? " " + bold(name) : ""}`);
				for (const link of node.links) {
					print(`${indent}  \u2192 ${dim(link.relationKey)}: ${short(link.targetId)}`);
				}
			}
			break;
		}

		case "neighbors": {
			const rawId = args[0];
			if (!rawId) { print(red("Usage: /graph neighbors <id>")); return; }
			const id = await resolveId(rawId);
			if (!id) { print(red("Not found: ") + rawId); return; }

			const { outbound, inbound } = await store.neighbors(id);

			if (outbound.length === 0 && inbound.length === 0) {
				print(dim("(no neighbors)"));
				return;
			}

			if (outbound.length > 0) {
				print(bold("outbound:"));
				for (const n of outbound) {
					print(`  ${cyan(n.relationKey.padEnd(16))} \u2192 ${short(n.id)} ${dim("(" + (n.typeKey || "?") + ")")}`);
				}
			}
			if (inbound.length > 0) {
				print(bold("inbound:"));
				for (const n of inbound) {
					print(`  ${cyan(n.relationKey.padEnd(16))} \u2190 ${short(n.id)} ${dim("(" + (n.typeKey || "?") + ")")}`);
				}
			}
			break;
		}

		default:
			print("Commands: links, traverse, neighbors");
	}
};

// ── Shared helpers for actor actions ────────────────────────────────

function asObj(input: unknown): Record<string, any> {
	if (input && typeof input === "object" && !Array.isArray(input)) return input as any;
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { /* fall through */ }
	}
	return {};
}

function resolveObjectIdArg(input: unknown): string {
	if (typeof input === "string") return input;
	const o = asObj(input);
	const id = o.object_id ?? o.id;
	if (typeof id !== "string" || !id) throw new Error("object_id required");
	return id;
}

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		links: async (ctx: ProgramContext, input: unknown) => {
			const id = resolveObjectIdArg(input);
			const store = ctx.store as any;
			const outbound = (await store.getLinks(id)) as Array<{ relationKey: string; targetId: string }>;
			const inbound = (await store.getBacklinks(id)) as Array<{ relationKey: string; sourceId: string }>;
			return {
				outbound: outbound.map((l) => ({ relation_key: l.relationKey, target_id: l.targetId })),
				inbound: inbound.map((l) => ({ relation_key: l.relationKey, source_id: l.sourceId })),
			};
		},

		neighbors: async (ctx: ProgramContext, input: unknown) => {
			const id = resolveObjectIdArg(input);
			const store = ctx.store as any;
			const result = await store.neighbors(id) as { outbound: any[]; inbound: any[] };
			return {
				outbound: (result.outbound ?? []).map((n: any) => ({
					id: n.id, type_key: n.typeKey, relation_key: n.relationKey,
				})),
				inbound: (result.inbound ?? []).map((n: any) => ({
					id: n.id, type_key: n.typeKey, relation_key: n.relationKey,
				})),
			};
		},

		traverse: async (ctx: ProgramContext, input: unknown) => {
			const o = asObj(input);
			const id = typeof input === "string" ? input : (o.object_id ?? o.id);
			if (!id || typeof id !== "string") throw new Error("traverse: object_id required");
			const requestedDepth = typeof o.max_depth === "number" ? o.max_depth : 2;
			const max_depth = Math.max(0, Math.min(requestedDepth, 5));
			const max_nodes = typeof o.max_nodes === "number" && o.max_nodes > 0 ? Math.min(o.max_nodes, 200) : 200;
			const nodes = (await (ctx.store as any).graphQuery(id, max_depth)) as Array<{
				id: string; typeKey: string; depth: number; links: Array<{ relationKey: string; targetId: string }>;
			}>;
			return {
				nodes: nodes.slice(0, max_nodes).map((n) => ({
					id: n.id, type_key: n.typeKey, depth: n.depth,
					links: (n.links ?? []).map((l) => ({ relation_key: l.relationKey, target_id: l.targetId })),
				})),
				truncated: nodes.length > max_nodes,
			};
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
