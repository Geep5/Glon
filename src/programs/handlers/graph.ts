import type { ProgramDef, ProgramContext } from "../runtime.js";

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

const program: ProgramDef = { handler };
export default program;
