/**
 * Agent block recall tests (M-Recall).
 *
 * Covers:
 *   - doRecall appends a new user_text block quoting the source block
 *     with framing that includes the original timestamp and role.
 *   - Each source shape (user_text, assistant_text, tool_use, tool_result,
 *     compaction_summary) renders distinctly.
 *   - Very large blocks are truncated at 8192 bytes.
 *   - Unknown block id throws with a clear message.
 *
 * Run: npx tsx --test test/agent-recall.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { __test } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

function createHarness() {
	const objects = new Map<string, { id: string; typeKey: string; fields: Record<string, any>; blocks: any[]; deleted?: boolean }>();
	let nextBlockTs = 1_700_000_000_000;

	function actorFor(id: string) {
		return {
			setField: async (key: string, json: string) => { objects.get(id)!.fields[key] = JSON.parse(json); },
			setFields: async () => {},
			addBlock: async (json: string) => {
				const obj = objects.get(id)!;
				const block = JSON.parse(json);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			markDeleted: async () => {},
			setContent: async () => {},
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id); if (!o) return null;
			const prov: Record<string, any> = {};
			for (const b of o.blocks) prov[b.id] = { timestamp: b.timestamp, author: "t", changeId: "t" };
			return { ...o, blockProvenance: prov, content: new Uint8Array(0), createdAt: 0, updatedAt: 0, headIds: [], changeCount: o.blocks.length };
		},
	};

	const client = { objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) } };

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => { for (const k of objects.keys()) if (k === p || k.startsWith(p)) return k; return null; },
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [], readChangeByHex: () => null, hexEncode: () => "",
		print: () => {},
		randomUUID: (() => { let n = 0; return () => `new-${++n}`; })(),
		state: {}, emit: () => {}, programId: "t",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async () => { throw new Error("no dispatcher needed"); },
	} as unknown as ProgramContext;

	return {
		ctx, objects,
		seedAgent(id: string, blocks: any[] = []) {
			objects.set(id, { id, typeKey: "agent", fields: {}, blocks: blocks.map((b) => ({ ...b, timestamp: b.timestamp ?? nextBlockTs++ })) });
			return id;
		},
	};
}

describe("doRecall", () => {
	it("recalls a user_text block with role framing and original timestamp", async () => {
		const h = createHarness();
		h.seedAgent("ag-1", [
			{ id: "b1", content: { text: { text: "hello world", style: 0 } }, timestamp: 1_700_000_000_000 },
		]);

		const result = await __test.doRecall("ag-1", "b1", h.ctx);
		assert.equal(result.sourceKind, "user_text");
		assert.equal(result.truncated, false);

		const agent = h.objects.get("ag-1")!;
		assert.equal(agent.blocks.length, 2);
		const injected = agent.blocks[1];
		assert.equal(injected.id, result.newBlockId);
		const text = injected.content.text.text;
		assert.match(text, /\[Recalled user turn from 2023-.*\]:/);
		assert.match(text, /hello world/);
		// The injected block's style must be user so it enters the next ask's user turn.
		assert.equal(injected.content.text.style, 0);
	});

	it("recalls an assistant_text block with assistant role", async () => {
		const h = createHarness();
		h.seedAgent("ag-2", [
			{ id: "b2", content: { text: { text: "I remember the answer is 42", style: 1 } } },
		]);
		const result = await __test.doRecall("ag-2", "b2", h.ctx);
		assert.equal(result.sourceKind, "assistant_text");
		const text = h.objects.get("ag-2")!.blocks[1].content.text.text;
		assert.match(text, /\[Recalled assistant turn/);
		assert.match(text, /42/);
	});

	it("recalls a tool_use block as a tool-call summary", async () => {
		const h = createHarness();
		h.seedAgent("ag-3", [
			{ id: "b3", content: { custom: { contentType: "tool_use", meta: { tool_name: "search", input: '{"q":"x"}', tool_use_id: "u1" } } } },
		]);
		const result = await __test.doRecall("ag-3", "b3", h.ctx);
		assert.equal(result.sourceKind, "tool_use");
		const text = h.objects.get("ag-3")!.blocks[1].content.text.text;
		assert.match(text, /\[Recalled tool call from/);
		assert.match(text, /search\(/);
	});

	it("recalls a tool_result block with error hint when applicable", async () => {
		const h = createHarness();
		h.seedAgent("ag-4", [
			{ id: "b4", content: { custom: { contentType: "tool_result", meta: { tool_use_id: "u1", content: "boom", is_error: "true" } } } },
		]);
		await __test.doRecall("ag-4", "b4", h.ctx);
		const text = h.objects.get("ag-4")!.blocks[1].content.text.text;
		assert.match(text, /\[Recalled tool result/);
		assert.match(text, /boom/);
		assert.match(text, /was an error/);
	});

	it("truncates oversized content at 8192 bytes", async () => {
		const h = createHarness();
		const huge = "x".repeat(20_000);
		h.seedAgent("ag-5", [{ id: "b5", content: { text: { text: huge, style: 0 } } }]);
		const result = await __test.doRecall("ag-5", "b5", h.ctx);
		assert.equal(result.truncated, true);
		const text = h.objects.get("ag-5")!.blocks[1].content.text.text;
		assert.ok(text.includes("recall truncated"));
		assert.ok(text.length < 9000);
	});

	it("throws when block id is not on the agent", async () => {
		const h = createHarness();
		h.seedAgent("ag-6", [{ id: "present", content: { text: { text: "a", style: 0 } } }]);
		await assert.rejects(() => __test.doRecall("ag-6", "missing", h.ctx), /block missing is not on agent/);
	});

	it("renderBlockForRecall handles the compaction_summary shape", () => {
		const block = { id: "c1", content: { custom: { contentType: "compaction_summary", meta: { summary: "prior turns compressed" } } } };
		const out = __test.renderBlockForRecall(block, "2024-01-01T00:00:00Z");
		assert.equal(out.kind, "compaction");
		assert.match(out.text, /prior turns compressed/);
	});
});
