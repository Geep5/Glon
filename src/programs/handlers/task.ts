/**
 * /task — thin CLI front-end for agent spawning.
 *
 * The real work lives in `/agent` (spawn / submitResult / cancel actions).
 * This program exists purely so humans get a `/task` verb at the shell
 * without juggling `/agent spawn <json>` semantics.
 *
 * Commands:
 *   /task spawn <parent-id> <batch-json>
 *   /task status <child-id>
 *   /task cancel <child-id>
 *
 * No actor — this program is pure plumbing. `spawn` dispatches to
 * `/agent.spawn` which owns the actual subagent machinery.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";
import { __test as agentInternals } from "./agent.js";

const { renderSubagentTree, countDescendants } = agentInternals;

// ── ANSI ─────────────────────────────────────────────────────────
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const red = (s: string) => `${RED}${s}${RESET}`;
const yellow = (s: string) => `${YELLOW}${s}${RESET}`;

function extractString(v: unknown): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (typeof v === "object" && v !== null && "stringValue" in (v as any)) {
		const s = (v as any).stringValue;
		return typeof s === "string" ? s : undefined;
	}
	return undefined;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx as any;

	switch (cmd) {
		case "spawn": {
			const raw = args[0];
			const batchArg = args.slice(1).join(" ");
			if (!raw || !batchArg) {
				print(red("Usage: /task spawn <parent-id> <batch-json>"));
				print(dim("  batch-json example:"));
				print(dim(`  '{"tasks":[{"id":"t1","agentTemplate":"explore","assignment":"map the repo"}]}'`));
				return;
			}
			const parentId = await resolveId(raw);
			if (!parentId) { print(red("Not found: ") + raw); return; }

			let batch: any;
			try {
				batch = JSON.parse(batchArg);
			} catch (err: any) {
				print(red("Invalid batch JSON: ") + (err?.message ?? String(err)));
				return;
			}
			const input = { agentId: parentId, ...batch };

			print(dim(`  dispatching /agent.spawn with ${batch.tasks?.length ?? 0} task(s)...`));
			try {
				const result = await ctx.dispatchProgram("/agent", "spawn", [JSON.stringify(input)]) as {
					childAgentIds: string[];
					results: Array<{ id: string; childAgentId: string; status: string; output: unknown; durationMs: number; tokens: { input: number; output: number }; error?: string }>;
				};
				print(green(`  spawned ${result.childAgentIds.length} child(ren):`));
				for (const r of result.results) {
					const statusColor = r.status === "ok" ? green : r.status === "no_submit_result" ? yellow : red;
					print(`  ${bold(r.id)} → ${statusColor(r.status)}  ${dim(r.childAgentId)}`);
					print(dim(`    ${r.tokens.input}+${r.tokens.output} tok · ${r.durationMs}ms`));
					if (r.error) print(red(`    error: ${r.error}`));
					const outStr = typeof r.output === "string" ? r.output : JSON.stringify(r.output);
					const preview = outStr.length > 240 ? outStr.slice(0, 240) + "…" : outStr;
					print(dim(`    output: ${preview}`));
				}
			} catch (err: any) {
				print(red("  spawn failed: ") + (err?.message ?? String(err)));
			}
			return;
		}

		case "status": {
			const raw = args[0];
			if (!raw) { print(red("Usage: /task status <child-id>")); return; }
			const childId = await resolveId(raw);
			if (!childId) { print(red("Not found: ") + raw); return; }
			const state = await (ctx.store as any).get(childId);
			if (!state) { print(red("Agent not found")); return; }
			if (state.typeKey !== "agent") { print(red(`Not an agent (typeKey=${state.typeKey})`)); return; }

			const f = state.fields ?? {};
			print(bold("task status: ") + childId);
			print(dim("  template:    ") + (extractString(f.spawn_template) ?? "(none)"));
			print(dim("  parent:      ") + (f.spawn_parent?.linkValue?.targetId ?? "(top-level)"));
			print(dim("  depth:       ") + (extractString(f.spawn_depth) ?? "0"));
			print(dim("  task_id:     ") + (extractString(f.spawn_task_id) ?? "(none)"));
			const submitted = extractString(f.submitted_result);
			if (submitted) {
				const when = extractString(f.submitted_at);
				print(green("  submitted:   ") + (when ? new Date(Number(when)).toISOString() : "yes"));
				print(dim("  result: ") + (submitted.length > 400 ? submitted.slice(0, 400) + "…" : submitted));
			} else {
				print(yellow("  submitted:   no"));
			}
			if (extractString(f.cancel_requested) === "true") {
				print(red("  cancelled:   yes"));
			}
			return;
		}

		case "tree": {
			const raw = args[0];
			if (!raw) { print(red("Usage: /task tree <agent-id>")); return; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); return; }
			try {
				// Fetch the tree via the /agent actor, then render locally so we
				// avoid duplicating the text renderer here.
				const root = await ctx.dispatchProgram("/agent", "getSubagents", [id]) as any;
				print(bold("spawn tree rooted at ") + root.id);
				print(renderSubagentTree(root));
				print(dim(`  ${countDescendants(root)} subagent(s) total`));
			} catch (err: any) {
				print(red("  tree failed: ") + (err?.message ?? String(err)));
			}
			return;
		}
		case "cancel": {
			const raw = args[0];
			if (!raw) { print(red("Usage: /task cancel <child-id>")); return; }
			const childId = await resolveId(raw);
			if (!childId) { print(red("Not found: ") + raw); return; }
			try {
				await ctx.dispatchProgram("/agent", "cancel", [childId]);
				print(green("  cancel requested for ") + childId);
			} catch (err: any) {
				print(red("  cancel failed: ") + (err?.message ?? String(err)));
			}
			return;
		}

		default:
			print(dim("Commands: spawn, status, tree, cancel"));
	}
};

const program: ProgramDef = { handler };
export default program;
