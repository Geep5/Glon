/**
 * Agent compaction tests.
 *
 * Covers the pure helpers (estimator, classify, findLatestCompaction,
 * filterToKept, groupIntoTurns, buildConversationView, findCutIndex,
 * buildEffectiveSystem, isContextOverflowError) and the integrated
 * flows (doCompact writes a well-formed summary block; runAsk auto-
 * compacts over threshold; overflow error triggers a retry; iterative
 * compaction supersedes an older summary).
 *
 * Run: npx tsx --test test/agent-compaction.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram, { estimateTokens, __test } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Helpers ──────────────────────────────────────────────────────

function restoreAnthropic() {
	delete (globalThis as any).__ANTHROPIC_FETCH;
}

interface StoredBlock {
	id: string;
	content: any;
	timestamp: number;
}

interface StoredAgent {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	blocks: StoredBlock[];
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredAgent>();
	let nextBlockTs = 1000;
	let nextId = 1;

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			setFields: async (fieldsJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				Object.assign(obj.fields, JSON.parse(fieldsJson));
			},
			addBlock: async (blockJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				const block = JSON.parse(blockJson);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (obj) obj.deleted = true;
			},
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const obj = objects.get(id);
			if (!obj) return null;
			const provenance: Record<string, any> = {};
			for (const b of obj.blocks) provenance[b.id] = { timestamp: b.timestamp, author: "test", changeId: "test" };
			return {
				id,
				typeKey: obj.typeKey,
				fields: obj.fields,
				blocks: obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content })),
				blockProvenance: provenance,
				deleted: obj.deleted,
				content: "",
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: obj.blocks.length,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `obj-${nextId++}`;
			objects.set(id, {
				id, typeKey,
				fields: fieldsJson ? JSON.parse(fieldsJson) : {},
				blocks: [],
				deleted: false,
			});
			return id;
		},
		list: async (typeKey?: string) => {
			const refs: { id: string; typeKey: string }[] = [];
			for (const o of objects.values()) {
				if (typeKey && o.typeKey !== typeKey) continue;
				refs.push({ id: o.id, typeKey: o.typeKey });
			}
			return refs;
		},
	};

	const client = {
		objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) },
	};

	const dispatchHandlers = new Map<string, (args: unknown[]) => unknown>();

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => {
			for (const k of objects.keys()) if (k === p || k.startsWith(p)) return k;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => `uuid-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-agent-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`no dispatch handler ${key}`);
			return handler(args);
		},
	};

	return {
		ctx, objects,
		onDispatch(prefix: string, action: string, handler: (args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, handler);
		},
		seedAgent(fields: Record<string, any> = {}) {
			const id = `agent-${nextId++}`;
			objects.set(id, { id, typeKey: "agent", fields, blocks: [], deleted: false });
			return id;
		},
		seedBlocks(agentId: string, blocks: Array<{ id?: string; content: any }>): string[] {
			const obj = objects.get(agentId)!;
			const created: string[] = [];
			for (const b of blocks) {
				const id = b.id ?? `block-${nextId++}`;
				obj.blocks.push({ id, content: b.content, timestamp: nextBlockTs++ });
				created.push(id);
			}
			return created;
		},
	};
}

function userText(text: string) { return { text: { text, style: 0 } }; }
function assistantText(text: string) { return { text: { text, style: 1 } }; }
function toolUseCustom(toolUseId: string, name: string, input: Record<string, unknown>) {
	return {
		custom: {
			contentType: "tool_use",
			data: "",
			meta: { tool_use_id: toolUseId, tool_name: name, input: JSON.stringify(input) },
		},
	};
}
function toolResultCustom(toolUseId: string, content: string, isError = false) {
	return {
		custom: {
			contentType: "tool_result",
			data: "",
			meta: { tool_use_id: toolUseId, content, is_error: isError ? "true" : "false" },
		},
	};
}
function compactionCustom(summary: string, firstKeptBlockId: string, tokensBefore = 0, turnCount = 0) {
	return {
		custom: {
			contentType: "compaction_summary",
			data: "",
			meta: {
				summary,
				first_kept_block_id: firstKeptBlockId,
				tokens_before: String(tokensBefore),
				turn_count: String(turnCount),
				created_at: String(Date.now()),
			},
		},
	};
}

// ── estimator ────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("estimates text length / 3.5 for strings", () => {
		assert.equal(estimateTokens("hello world"), Math.ceil(11 / 3.5));
		assert.equal(estimateTokens(""), 0);
	});

	it("sums across content arrays with tool blocks weighted", () => {
		const content = [
			{ type: "text" as const, text: "abc" },
			{ type: "tool_use" as const, id: "x", name: "calc", input: { a: 1 } },
			{ type: "tool_result" as const, tool_use_id: "x", content: "result body" },
		];
		const total = estimateTokens(content);
		const expected =
			Math.ceil(3 / 3.5) +
			Math.ceil(("calc" + JSON.stringify({ a: 1 })).length / 3.5) +
			Math.ceil("result body".length / 3.5);
		assert.equal(total, expected);
	});
});

// ── classify + buildConversationView ─────────────────────────────

describe("classifyBlocks + buildConversationView", () => {
	it("classifies every block kind and emits a clean turn list when no compaction exists", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const ids = h.seedBlocks(id, [
			{ content: userText("hi") },
			{ content: assistantText("hey!") },
			{ content: toolUseCustom("tu_1", "echo", { v: 1 }) },
			{ content: toolResultCustom("tu_1", "1") },
			{ content: assistantText("done") },
		]);
		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));

		const items = __test.classifyBlocks(storeBlocks, provenance);
		assert.equal(items.length, 5);
		assert.deepEqual(items.map((i) => i.kind), ["user_text", "assistant_text", "tool_use", "tool_result", "assistant_text"]);

		const view = __test.buildConversationView(storeBlocks, provenance);
		assert.equal(view.systemExtension, undefined);
		assert.equal(view.latestCompaction, null);
		assert.equal(view.turns.length, 4);
		assert.equal(view.turns[0].role, "user");
		assert.equal(view.turns[1].role, "assistant");
		assert.equal(view.turns[2].role, "user");
		assert.equal(view.turns[3].role, "assistant");
		void ids;
	});

	it("honours the latest compaction block: summary becomes systemExtension, pre-cut blocks are dropped", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const [u1, , u2, a2] = h.seedBlocks(id, [
			{ content: userText("first") },
			{ content: assistantText("ans1") },
			{ content: userText("second") },
			{ content: assistantText("ans2") },
		]);
		// Compaction block: first kept is u2, summary replaces u1/a1
		h.seedBlocks(id, [
			{ content: compactionCustom("SUMMARY-A", u2, 100, 1) },
		]);

		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));
		const view = __test.buildConversationView(storeBlocks, provenance);

		assert.equal(view.systemExtension, "SUMMARY-A");
		assert.equal(view.latestCompaction?.summary, "SUMMARY-A");
		// Kept turns are just u2 + a2.
		assert.equal(view.turns.length, 2);
		assert.equal(view.turns[0].content, "second");
		assert.equal(view.turns[1].content, "ans2");
		void u1; void a2;
	});

	it("latest compaction wins when multiple exist", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const ids = h.seedBlocks(id, [
			{ content: userText("a") },
			{ content: userText("b") },
			{ content: userText("c") },
		]);
		// Older compaction first, newer second
		h.seedBlocks(id, [
			{ content: compactionCustom("OLD", ids[1], 10, 1) },
			{ content: compactionCustom("NEW", ids[2], 20, 1) },
		]);

		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));
		const view = __test.buildConversationView(storeBlocks, provenance);

		assert.equal(view.systemExtension, "NEW");
		assert.equal(view.turns.length, 1);
		assert.equal(view.turns[0].content, "c");
	});
});

// ── findCutIndex ─────────────────────────────────────────────────

describe("findCutIndex", () => {
	function bigUser(text: string, tokens: number) {
		return { kind: "user_text" as const, blockId: "b", text: "x".repeat(tokens * 4), timestamp: 0 };
	}
	function smallAssistant(tokens: number) {
		return { kind: "assistant_text" as const, blockId: "b", text: "x".repeat(tokens * 4), timestamp: 0 };
	}

	it("returns null when the whole conversation fits under keepRecentTokens", () => {
		const items = [bigUser("u1", 100), smallAssistant(100)];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});

	it("cuts at the user-text boundary once budget is hit", () => {
		// Four turns, ~500 tokens each (2000 total). keepRecent = 800.
		// Walking backward: a4=500, u4=500+500=1000 ≥ 800 → cut at index of u4.
		const items = [
			{ ...bigUser("u1", 500), blockId: "u1" },
			smallAssistant(500),
			{ ...bigUser("u2", 500), blockId: "u2" },
			smallAssistant(500),
		];
		const cut = __test.findCutIndex(items, 800);
		// Budget hit at the first user we encounter walking backward whose cumulative ≥ 800.
		// Rearranged: indices = [u1(0), a1(1), u2(2), a2(3)]. Walking newest: a2→500, u2→1000 (≥800, user). cut=2.
		assert.equal(cut, 2);
	});

	it("returns null if a single turn alone exceeds the keep budget (no user boundary in kept range)", () => {
		// Single huge turn: u1 + huge assistant. Walking backward from assistant hits budget
		// but there's only one user at index 0 and we reject index 0.
		const items = [
			{ ...bigUser("u1", 100), blockId: "u1" },
			smallAssistant(5000),
		];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});

	it("never returns index 0 (no point compacting the whole thing)", () => {
		const items = [
			{ ...bigUser("u1", 10000), blockId: "u1" },
		];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});
});

// ── doCompact ────────────────────────────────────────────────────

describe("doCompact", () => {
	afterEach(restoreAnthropic);

	it("writes a compaction_summary block with the right meta fields", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			// keep-recent = 20 tokens (tiny, forces a cut)
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Eight turns, each small. Total will exceed 20.
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(30)) },
			{ content: assistantText("a1 " + "x".repeat(30)) },
			{ content: userText("u2 " + "x".repeat(30)) },
			{ content: assistantText("a2 " + "x".repeat(30)) },
			{ content: userText("u3 " + "x".repeat(30)) },
			{ content: assistantText("a3 " + "x".repeat(30)) },
			{ content: userText("u4 " + "x".repeat(30)) },
			{ content: assistantText("a4 " + "x".repeat(30)) },
		]);

		// Mock the summarisation LLM call.
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			// Expect the user message to be the structured summary prompt.
			const body = req.messages[0].content as string;
			assert.match(body, /summarising an agent's conversation/);
			assert.match(body, /## Goal/);
			return {
				content: [{ type: "text", text: "## Goal\nTest summary goal." }],
				stopReason: "end_turn",
				model: "test-model",
				inputTokens: 100,
				outputTokens: 20,
			};
		};

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, true);
		assert.ok(result.blockId);
		assert.ok(result.firstKeptBlockId);
		assert.ok((result.tokensBefore ?? 0) > 0);

		// The compaction block is on the agent.
		const obj = h.objects.get(agentId)!;
		const last = obj.blocks[obj.blocks.length - 1];
		assert.equal(last.content.custom.contentType, "compaction_summary");
		assert.match(last.content.custom.meta.summary, /Test summary goal/);
		assert.equal(last.content.custom.meta.first_kept_block_id, result.firstKeptBlockId);
		assert.ok(parseInt(last.content.custom.meta.tokens_before, 10) > 0);
		assert.ok(parseInt(last.content.custom.meta.turn_count, 10) >= 1);
	});

	it("returns compacted=false with no_cut_point when conversation fits under the budget", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_keep_recent_tokens: stringVal("100000"), // huge budget
		});
		h.seedBlocks(agentId, [{ content: userText("tiny") }]);

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, false);
		assert.equal(result.reason, "no_cut_point");
	});

	it("respects compaction_enabled=false", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_enabled: stringVal("false"),
		});
		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, false);
		assert.equal(result.reason, "disabled");
	});

	it("feeds prior summary into the next compaction as context", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Seed some blocks + a prior compaction.
		const [u1, , u2, , u3, a3] = h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(100)) },
			{ content: assistantText("a1 " + "x".repeat(100)) },
			{ content: userText("u2 " + "x".repeat(100)) },
			{ content: assistantText("a2 " + "x".repeat(100)) },
			{ content: userText("u3 " + "x".repeat(100)) },
			{ content: assistantText("a3 " + "x".repeat(100)) },
		]);
		// Prior compaction: firstKept = u2, so pre-cut was u1/a1.
		h.seedBlocks(agentId, [
			{ content: compactionCustom("PRIOR-SUMMARY-TEXT", u2, 50, 1) },
		]);

		let lastPrompt = "";
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			lastPrompt = req.messages[0].content as string;
			return {
				content: [{ type: "text", text: "## Goal\nNew summary." }],
				stopReason: "end_turn",
				model: "m",
				inputTokens: 50, outputTokens: 10,
			};
		};

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, true);
		// The prompt should reference the prior summary text.
		assert.match(lastPrompt, /Prior summary being superseded/);
		assert.match(lastPrompt, /PRIOR-SUMMARY-TEXT/);
		// The new block records the prior_summary_id.
		const obj = h.objects.get(agentId)!;
		const last = obj.blocks[obj.blocks.length - 1];
		assert.ok(last.content.custom.meta.prior_summary_id, "should link to prior compaction");
		void u1; void u3; void a3;
	});

	it("doCompact with customInstructions adds focus text to the prompt", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({ compaction_keep_recent_tokens: stringVal("20") });
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(100)) },
			{ content: assistantText("a1 " + "x".repeat(100)) },
			{ content: userText("u2 " + "x".repeat(100)) },
			{ content: assistantText("a2 " + "x".repeat(100)) },
		]);

		let lastPrompt = "";
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			lastPrompt = req.messages[0].content as string;
			return {
				content: [{ type: "text", text: "## Goal\nSummary." }],
				stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
			};
		};

		await __test.doCompact(agentId, "focus on upcoming doctor appointment", h.ctx);
		assert.match(lastPrompt, /focus on upcoming doctor appointment/);
	});
});

// ── runAsk integration ───────────────────────────────────────────

describe("runAsk auto-compaction", () => {
	afterEach(restoreAnthropic);

	it("auto-compacts before the ask when token estimate exceeds threshold", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			compaction_context_window: stringVal("500"),
			compaction_reserve_tokens: stringVal("100"), // threshold = 400
			compaction_keep_recent_tokens: stringVal("50"),
		});
		// Seed blocks totalling ~800 tokens so threshold is tripped.
		for (let i = 0; i < 4; i++) {
			h.seedBlocks(agentId, [
				{ content: userText("u" + i + " " + "x".repeat(200)) },
				{ content: assistantText("a" + i + " " + "x".repeat(200)) },
			]);
		}

		let summaryCalled = false;
		let askCalled = false;
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising an agent's conversation")) {
				summaryCalled = true;
				return {
					content: [{ type: "text", text: "## Goal\nCompressed." }],
					stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
				};
			}
			askCalled = true;
			return {
				content: [{ type: "text", text: "After-compaction reply" }],
				stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
			};
		};

		const result = await __test.runAsk(agentId, "new question", h.ctx);
		assert.equal(summaryCalled, true, "summary LLM should have been invoked");
		assert.equal(askCalled, true, "ask LLM should have been invoked");
		assert.equal(result.compactedBeforeAsk, true);
		assert.equal(result.finalText, "After-compaction reply");
	});

	it("does NOT compact when under threshold", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			compaction_context_window: stringVal("100000"), // huge threshold
			compaction_reserve_tokens: stringVal("1000"),
			compaction_keep_recent_tokens: stringVal("50"),
		});
		h.seedBlocks(agentId, [{ content: userText("hi") }]);

		let summaryCalled = false;
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising")) {
				summaryCalled = true;
			}
			return {
				content: [{ type: "text", text: "reply" }],
				stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
			};
		};
		const result = await __test.runAsk(agentId, "q", h.ctx);
		assert.equal(summaryCalled, false);
		assert.equal(result.compactedBeforeAsk, false);
	});

	it("retries once after a context-overflow error by compacting first", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			// Force it under the auto-compact threshold so the retry is the only compaction path.
			compaction_context_window: stringVal("1000000"),
			compaction_reserve_tokens: stringVal("1000"),
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Seed multi-turn history so a cut point exists when compaction is forced on overflow.
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(200)) },
			{ content: assistantText("a1 " + "x".repeat(200)) },
			{ content: userText("u2 " + "x".repeat(200)) },
			{ content: assistantText("a2 " + "x".repeat(200)) },
		]);

		let askAttempts = 0;
		let summaryCalled = false;
		(globalThis as any).__ANTHROPIC_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising")) {
				summaryCalled = true;
				return {
					content: [{ type: "text", text: "## Goal\nSummary." }],
					stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
				};
			}
			askAttempts++;
			if (askAttempts === 1) {
				throw new Error("Anthropic API 400: prompt is too long: 300000 tokens");
			}
			return {
				content: [{ type: "text", text: "worked after retry" }],
				stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
			};
		};

		const result = await __test.runAsk(agentId, "question", h.ctx);
		assert.equal(summaryCalled, true);
		assert.equal(askAttempts, 2);
		assert.equal(result.compactedOnOverflow, true);
		assert.equal(result.finalText, "worked after retry");
	});

	it("isContextOverflowError recognises typical error shapes", () => {
		assert.equal(__test.isContextOverflowError(new Error("Anthropic API 400: prompt is too long: 300k tokens")), true);
		assert.equal(__test.isContextOverflowError(new Error("context_length_exceeded for model ...")), true);
		assert.equal(__test.isContextOverflowError(new Error("rate_limit_error")), false);
		assert.equal(__test.isContextOverflowError(new Error("invalid_api_key")), false);
	});
});

// ── buildEffectiveSystem ─────────────────────────────────────────

describe("buildEffectiveSystem", () => {
	it("returns undefined when both parts are empty", () => {
		assert.equal(__test.buildEffectiveSystem(undefined, undefined), undefined);
	});
	it("returns base when there's no summary", () => {
		assert.equal(__test.buildEffectiveSystem("base prompt", undefined), "base prompt");
	});
	it("wraps summary in conversation-summary tags appended to base", () => {
		const sys = __test.buildEffectiveSystem("base", "S");
		assert.equal(sys, "base\n\n<conversation-summary>\nS\n</conversation-summary>");
	});
	it("returns only the summary block when base is empty", () => {
		const sys = __test.buildEffectiveSystem(undefined, "S");
		assert.equal(sys, "<conversation-summary>\nS\n</conversation-summary>");
	});
});
