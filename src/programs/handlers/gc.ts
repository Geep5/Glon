/**
 * Garbage Collection — a tool, not a policy.
 *
 * GC is a program that other programs use. It provides:
 *   - protect/unprotect: mark objects as retained
 *   - reachability: walk the link graph from protected roots
 *   - collect: delete objects that aren't protected or reachable
 *
 * GC has no opinions about retention. Programs decide what to protect.
 * The link graph determines what's reachable. Everything else is eligible.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }

// ── Link reachability ────────────────────────────────────────────

/** BFS from a set of roots, following outbound links. Returns all reachable IDs. */
async function reachableFrom(roots: Set<string>, store: any): Promise<Set<string>> {
	const visited = new Set<string>();
	const queue = [...roots];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		try {
			const links: { targetId: string }[] = await store.getLinks(id);
			for (const link of links) {
				if (!visited.has(link.targetId)) queue.push(link.targetId);
			}
		} catch {
			// Object may not exist or links unavailable
		}
	}
	return visited;
}

// ── GC State ─────────────────────────────────────────────────────

interface GCState {
	id: string;
	value: {
		protected: string[];
		stats: { runs: number; collected: number };
	};
}

// ── CLI Handler ──────────────────────────────────────────────────

async function handler(cmd: string, args: string[], ctx: ProgramContext): Promise<void> {
	const { store, print } = ctx as any;

	switch (cmd) {
		case "run": {
			const dryRun = args.includes("--dry-run");
			const protectedIds = new Set<string>((ctx as any).state?.value?.protected ?? []);

			// Everything reachable from protected roots survives
			const reachable = await reachableFrom(protectedIds, store);

			const objects = await store.list();
			let collected = 0;

			for (const obj of objects) {
				if (reachable.has(obj.id)) continue;

				if (dryRun) {
					print(yellow("  eligible: ") + dim(obj.id.slice(0, 12) + "...") + ` (${obj.typeKey})`);
				} else {
					await store.delete(obj.id);
					print(green("  collected: ") + dim(obj.id.slice(0, 12) + "...") + ` (${obj.typeKey})`);
				}
				collected++;
			}

			print(bold(`\n  ${dryRun ? "preview" : "done"}: ${collected} eligible, ${reachable.size} retained`));
			break;
		}

		case "protect": {
			const rawId = args[0];
			if (!rawId) { print(red("Usage: /gc protect <id>")); return; }
			const id = await (ctx as any).resolveId(rawId);
			if (!id) { print(red("Not found: ") + rawId); return; }

			const state = (ctx as any).state?.value;
			if (state && !state.protected.includes(id)) {
				state.protected.push(id);
			}

			const reachable = await reachableFrom(new Set([id]), store);
			reachable.delete(id);
			print(green("  protected: ") + id.slice(0, 12) + "...");
			if (reachable.size > 0) {
				print(dim(`  +${reachable.size} reachable via links`));
			}
			break;
		}

		case "unprotect": {
			const rawId = args[0];
			if (!rawId) { print(red("Usage: /gc unprotect <id>")); return; }
			const id = await (ctx as any).resolveId(rawId);
			if (!id) { print(red("Not found: ") + rawId); return; }

			const state = (ctx as any).state?.value;
			if (state) {
				state.protected = state.protected.filter((p: string) => p !== id);
			}
			print(green("  unprotected: ") + id.slice(0, 12) + "...");
			break;
		}

		case "status": {
			const protectedIds: string[] = (ctx as any).state?.value?.protected ?? [];
			const stats = (ctx as any).state?.value?.stats ?? { runs: 0, collected: 0 };
			const reachable = await reachableFrom(new Set(protectedIds), store);

			print(bold("  GC status"));
			print(`    protected roots:  ${protectedIds.length}`);
			print(`    total reachable:  ${reachable.size}`);
			print(`    runs:             ${stats.runs}`);
			print(`    collected:        ${stats.collected}`);

			if (protectedIds.length > 0) {
				print(bold("\n  roots:"));
				for (const id of protectedIds) {
					print(`    ${id.slice(0, 12)}...`);
				}
			}
			break;
		}

		default:
			print(bold("  Garbage Collection"));
			print(`    ${cyan("/gc run")} ${dim("[--dry-run]")}    Collect unprotected, unreachable objects`);
			print(`    ${cyan("/gc protect")} ${dim("<id>")}       Protect object (transitive via links)`);
			print(`    ${cyan("/gc unprotect")} ${dim("<id>")}     Remove protection`);
			print(`    ${cyan("/gc status")}                Show protected roots and reachability`);
	}
}

// ── Program Definition ───────────────────────────────────────────

const program: ProgramDef = {
	handler,

	actor: {
		createState: (): GCState => ({
			id: "gc",
			value: {
				protected: [],
				stats: { runs: 0, collected: 0 },
			},
		}),

		actions: {
			/** Mark an object as a GC root. Callable by other programs. */
			protect: (ctx: ProgramContext, objectId: string) => {
				const state = (ctx as any).state?.value;
				if (state && !state.protected.includes(objectId)) {
					state.protected.push(objectId);
				}
			},

			/** Remove an object as a GC root. Callable by other programs. */
			unprotect: (ctx: ProgramContext, objectId: string) => {
				const state = (ctx as any).state?.value;
				if (state) {
					state.protected = state.protected.filter((id: string) => id !== objectId);
				}
			},

			/** Check if an object is retained (root or reachable from a root). */
			isRetained: async (ctx: ProgramContext, objectId: string): Promise<boolean> => {
				const state = (ctx as any).state?.value;
				if (!state) return false;
				const roots = new Set<string>(state.protected);
				if (roots.has(objectId)) return true;
				const reachable = await reachableFrom(roots, (ctx as any).store);
				return reachable.has(objectId);
			},

			/** Get all retained object IDs (roots + reachable). */
			getRetained: async (ctx: ProgramContext): Promise<string[]> => {
				const state = (ctx as any).state?.value;
				if (!state) return [];
				const reachable = await reachableFrom(new Set(state.protected), (ctx as any).store);
				return [...reachable];
			},
		},
	},
};

export default program;
