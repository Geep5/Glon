/**
 * /task CLI + Gracie spawn wiring tests (M2).
 *
 * Covers:
 *   - /task spawn parses a batch-JSON arg and dispatches to /agent.spawn
 *     with {agentId, ...batch} merged, printing results + child ids.
 *   - /task spawn surfaces dispatch errors without crashing the shell.
 *   - /task status reads spawn_parent / spawn_depth / submitted_result
 *     fields off the child agent.
 *   - /task cancel dispatches to /agent.cancel.
 *   - Gracie's buildGracieTools result includes a spawn tool bound to
 *     gracieAgentId so the model can delegate to subagents.
 *
 * Run: npx tsx --test test/task-program.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import taskProgram from "../src/programs/handlers/task.js";
import { spawnTool } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Harness ──────────────────────────────────────────────────────

function createTaskHarness() {
	const objects = new Map<string, { id: string; typeKey: string; fields: Record<string, any>; deleted?: boolean }>();
	const dispatchHandlers = new Map<string, (action: string, args: unknown[]) => unknown>();
	const dispatchCalls: Array<{ prefix: string; action: string; args: unknown[] }> = [];
	const printed: string[] = [];

	const store = {
		get: async (id: string) => {
			const obj = objects.get(id);
			if (!obj) return null;
			return { ...obj, blocks: [], blockProvenance: {}, content: new Uint8Array(0), createdAt: 0, updatedAt: 0, headIds: [], changeCount: 0 };
		},
	};

	const ctx: ProgramContext = {
		client: { objectActor: { getOrCreate: () => ({}) } },
		store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) if (k === prefix || k.startsWith(prefix)) return k;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [], readChangeByHex: () => null, hexEncode: () => "",
		print: (s: string) => printed.push(s),
		randomUUID: () => "uuid-1",
		state: {}, emit: () => {}, programId: "test-task",
		objectActor: () => ({}),
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			const handler = dispatchHandlers.get(`${prefix}::${action}`);
			if (!handler) throw new Error(`No dispatch handler for ${prefix}::${action}`);
			return handler(action, args);
		},
	} as unknown as ProgramContext;

	return {
		ctx, objects, printed, dispatchCalls,
		onDispatch(prefix: string, action: string, handler: (action: string, args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, handler);
		},
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields });
			return id;
		},
	};
}

function joinPrint(h: ReturnType<typeof createTaskHarness>): string {
	// Strip ANSI so substring checks are stable across colour codes.
	return h.printed.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Tests ────────────────────────────────────────────────────────

describe("/task spawn", () => {
	it("dispatches to /agent.spawn with merged {agentId, ...batch}", async () => {
		const h = createTaskHarness();
		h.seedAgent("parent-1");
		h.onDispatch("/agent", "spawn", async (_a, args) => {
			const input = JSON.parse(args[0] as string);
			assert.equal(input.agentId, "parent-1");
			assert.equal(input.tasks.length, 2);
			assert.equal(input.context, "shared background");
			return {
				childAgentIds: ["c1", "c2"],
				results: [
					{ id: "t1", childAgentId: "c1", status: "ok", output: { ok: true }, durationMs: 12, tokens: { input: 5, output: 7 } },
					{ id: "t2", childAgentId: "c2", status: "no_submit_result", output: "raw text", durationMs: 14, tokens: { input: 3, output: 2 }, error: "subagent finished without calling submit_result" },
				],
			};
		});

		const batch = JSON.stringify({
			context: "shared background",
			tasks: [
				{ id: "t1", agentTemplate: "task", assignment: "do a" },
				{ id: "t2", agentTemplate: "explore", assignment: "do b" },
			],
		});
		await taskProgram.handler("spawn", ["parent-1", batch], h.ctx);

		const out = joinPrint(h);
		assert.match(out, /spawned 2 child/);
		assert.match(out, /t1.*ok/);
		assert.match(out, /t2.*no_submit_result/);
		assert.match(out, /c1/);
		assert.equal(h.dispatchCalls.filter((c) => c.prefix === "/agent" && c.action === "spawn").length, 1);
	});

	it("prints a usage hint when args are missing", async () => {
		const h = createTaskHarness();
		await taskProgram.handler("spawn", [], h.ctx);
		assert.match(joinPrint(h), /Usage: \/task spawn/);
	});

	it("surfaces a clear error when batch JSON is malformed", async () => {
		const h = createTaskHarness();
		h.seedAgent("parent-bad");
		await taskProgram.handler("spawn", ["parent-bad", "{not json"], h.ctx);
		assert.match(joinPrint(h), /Invalid batch JSON/);
	});

	it("surfaces dispatch errors without crashing", async () => {
		const h = createTaskHarness();
		h.seedAgent("parent-err");
		h.onDispatch("/agent", "spawn", () => { throw new Error("boom"); });
		await taskProgram.handler("spawn", ["parent-err", '{"tasks":[{"id":"x","agentTemplate":"task","assignment":"go"}]}'], h.ctx);
		assert.match(joinPrint(h), /spawn failed: boom/);
	});
});

describe("/task status", () => {
	it("prints spawn lineage and submitted result", async () => {
		const h = createTaskHarness();
		h.seedAgent("child-1", {
			spawn_template: stringVal("explore"),
			spawn_parent: linkVal("parent-1", "spawn_parent"),
			spawn_depth: stringVal("2"),
			spawn_task_id: stringVal("task-alpha"),
			submitted_result: stringVal(JSON.stringify({ findings: [1, 2, 3] })),
			submitted_at: stringVal(String(Date.parse("2026-04-24T00:00:00Z"))),
		});

		await taskProgram.handler("status", ["child-1"], h.ctx);
		const out = joinPrint(h);
		assert.match(out, /template:\s+explore/);
		assert.match(out, /parent:\s+parent-1/);
		assert.match(out, /depth:\s+2/);
		assert.match(out, /task_id:\s+task-alpha/);
		assert.match(out, /submitted:/);
		assert.match(out, /findings/);
	});

	it("notes when child was cancelled", async () => {
		const h = createTaskHarness();
		h.seedAgent("child-2", { cancel_requested: stringVal("true") });
		await taskProgram.handler("status", ["child-2"], h.ctx);
		assert.match(joinPrint(h), /cancelled:\s+yes/);
	});
});

describe("/task cancel", () => {
	it("dispatches to /agent.cancel", async () => {
		const h = createTaskHarness();
		h.seedAgent("child-3");
		let cancelled = "";
		h.onDispatch("/agent", "cancel", async (_a, args) => { cancelled = args[0] as string; return { ok: true }; });
		await taskProgram.handler("cancel", ["child-3"], h.ctx);
		assert.equal(cancelled, "child-3");
		assert.match(joinPrint(h), /cancel requested for child-3/);
	});
});

describe("Gracie spawn wiring", () => {
	it("spawnTool binds agentId to the caller so the model cannot spoof a parent", () => {
		const t = spawnTool("gracie-123");
		assert.equal(t.name, "spawn");
		assert.equal(t.target_prefix, "/agent");
		assert.equal(t.target_action, "spawn");
		assert.deepEqual(t.bound_args, { agentId: "gracie-123" });
		assert.match(JSON.stringify(t.input_schema), /tasks/);
	});
});
