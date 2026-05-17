/**
 * Comment program tests.
 *
 * Exercises the actor-level API (post / reply / react / unreact / list / thread)
 * + the buildMessageRecords helper. In-memory store harness with block tree
 * support and removeBlock so the unreact path works.
 *
 * Run: npx tsx --test test/comment.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import commentProgram, {
	__test,
	MESSAGE_CONTENT_TYPE,
	REACTION_CONTENT_TYPE,
} from "../src/programs/handlers/comment.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

interface StoredBlock {
	id: string;
	content: any;
	timestamp: number;
}

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	blocks: StoredBlock[];
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredObj>();
	let nextBlockTs = 1000;
	let nextId = 1;

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				o.fields[key] = JSON.parse(valueJson);
			},
			setFields: async (fieldsJson: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				Object.assign(o.fields, JSON.parse(fieldsJson));
			},
			markDeleted: async () => {
				const o = objects.get(id);
				if (o) o.deleted = true;
			},
			addBlock: async (blockJson: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				const block = JSON.parse(blockJson);
				o.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			removeBlock: async (blockId: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				o.blocks = o.blocks.filter((b) => b.id !== blockId);
			},
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id);
			if (!o) return null;
			return {
				id, typeKey: o.typeKey, fields: o.fields, deleted: o.deleted,
				blocks: o.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content })),
				blockProvenance: Object.fromEntries(o.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "test", changeId: "test" }])),
				content: "", createdAt: 0, updatedAt: 0, headIds: [], changeCount: 0,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `obj-${nextId++}`;
			objects.set(id, {
				id, typeKey,
				fields: fieldsJson ? JSON.parse(fieldsJson) : {},
				blocks: [], deleted: false,
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

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => objects.has(p) ? p : null,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => `block-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-comment",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async () => { throw new Error("not used"); },
	};

	return {
		ctx, objects,
		seedObject(typeKey: string, fields: Record<string, any> = {}): string {
			const id = `obj-${nextId++}`;
			objects.set(id, { id, typeKey, fields, blocks: [], deleted: false });
			return id;
		},
	};
}

// ── post ─────────────────────────────────────────────────────────

describe("comment.post", () => {
	it("creates a message block on the target object with correctly-shaped content", async () => {
		const h = createHarness();
		const target = h.seedObject("page", { name: stringVal("My page") });
		const post = commentProgram.actor!.actions!.post;

		const r = await post(h.ctx, { objectId: target, text: "first comment" }) as { block_id: string };

		const obj = h.objects.get(target)!;
		assert.equal(obj.blocks.length, 1);
		const block = obj.blocks[0];
		assert.equal(block.id, r.block_id);
		const ct = block.content?.custom?.contentType;
		assert.equal(ct, MESSAGE_CONTENT_TYPE);
		assert.equal(block.content.custom.meta.text, "first comment");
		assert.equal(block.content.custom.meta.reply_to, undefined);
	});

	it("stores creator + reply_to + attachments + created_at in meta when given", async () => {
		const h = createHarness();
		const target = h.seedObject("milestone");
		const post = commentProgram.actor!.actions!.post;

		const r = await post(h.ctx, {
			objectId: target,
			text: "with metadata",
			creator: "peer-grant",
			reply_to: "block-deadbeef",
			attachments: [{ object_id: "obj-image-1", kind: "image" }],
		}) as { block_id: string };

		const obj = h.objects.get(target)!;
		const meta = obj.blocks[0].content.custom.meta;
		assert.equal(meta.text, "with metadata");
		assert.equal(meta.creator, "peer-grant");
		assert.equal(meta.reply_to, "block-deadbeef");
		assert.deepEqual(JSON.parse(meta.attachments), [{ object_id: "obj-image-1", kind: "image" }]);
		assert.ok(parseInt(meta.created_at, 10) > 0);
		void r;
	});

	it("rejects empty / whitespace-only text", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		await assert.rejects(
			() => post(h.ctx, { objectId: target, text: "" }),
			/text required/,
		);
		await assert.rejects(
			() => post(h.ctx, { objectId: target, text: "   " }),
			/text required/,
		);
	});

	it("rejects malformed attachments (missing object_id, non-array, etc.)", async () => {
		const h = createHarness();
		const target = h.seedObject("page");
		const post = commentProgram.actor!.actions!.post;
		await assert.rejects(
			() => post(h.ctx, { objectId: target, text: "x", attachments: [{} as any] }),
			/attachment\.object_id required/,
		);
		await assert.rejects(
			() => post(h.ctx, { objectId: target, text: "x", attachments: "not an array" as any }),
			/attachments must be an array/,
		);
	});

	it("works on any object type — milestone, peer, reminder, page", async () => {
		const h = createHarness();
		const post = commentProgram.actor!.actions!.post;
		for (const typeKey of ["milestone", "peer", "reminder", "page", "agent"]) {
			const target = h.seedObject(typeKey);
			await post(h.ctx, { objectId: target, text: `discussion on ${typeKey}` });
			const obj = h.objects.get(target)!;
			assert.equal(obj.blocks.length, 1, `expected one block on ${typeKey}`);
		}
	});
});

// ── reply ────────────────────────────────────────────────────────

describe("comment.reply", () => {
	it("posts a message with reply_to set to the parent block_id", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		const reply = commentProgram.actor!.actions!.reply;

		const root = await post(h.ctx, { objectId: target, text: "hello" }) as { block_id: string };
		const child = await reply(h.ctx, {
			objectId: target,
			parent_block_id: root.block_id,
			text: "hi back",
		}) as { block_id: string };

		const obj = h.objects.get(target)!;
		const childBlock = obj.blocks.find((b) => b.id === child.block_id)!;
		assert.equal(childBlock.content.custom.meta.reply_to, root.block_id);
	});

	it("rejects missing parent_block_id", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const reply = commentProgram.actor!.actions!.reply;
		await assert.rejects(
			() => reply(h.ctx, { objectId: target, parent_block_id: "", text: "x" }),
			/parent_block_id required/,
		);
	});
});

// ── react / unreact ──────────────────────────────────────────────

describe("comment.react / unreact", () => {
	it("react adds a reaction block targeting the message", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		const react = commentProgram.actor!.actions!.react;

		const msg = await post(h.ctx, { objectId: target, text: "fire post" }) as { block_id: string };
		const r = await react(h.ctx, {
			objectId: target,
			message_block_id: msg.block_id,
			emoji: "🔥",
			creator: "peer-grant",
		}) as { block_id: string };

		const obj = h.objects.get(target)!;
		assert.equal(obj.blocks.length, 2);
		const reactionBlock = obj.blocks.find((b) => b.id === r.block_id)!;
		const ct = reactionBlock.content?.custom?.contentType;
		assert.equal(ct, REACTION_CONTENT_TYPE);
		const meta = reactionBlock.content.custom.meta;
		assert.equal(meta.target, msg.block_id);
		assert.equal(meta.emoji, "🔥");
		assert.equal(meta.creator, "peer-grant");
	});

	it("unreact removes the reaction block", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		const react = commentProgram.actor!.actions!.react;
		const unreact = commentProgram.actor!.actions!.unreact;

		const msg = await post(h.ctx, { objectId: target, text: "post" }) as { block_id: string };
		const r = await react(h.ctx, { objectId: target, message_block_id: msg.block_id, emoji: "👍" }) as { block_id: string };

		assert.equal(h.objects.get(target)!.blocks.length, 2);

		await unreact(h.ctx, { objectId: target, reaction_block_id: r.block_id });

		const remaining = h.objects.get(target)!.blocks;
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].id, msg.block_id);
	});

	it("rejects react without emoji or message id", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const react = commentProgram.actor!.actions!.react;
		await assert.rejects(
			() => react(h.ctx, { objectId: target, message_block_id: "", emoji: "👍" }),
			/message_block_id required/,
		);
		await assert.rejects(
			() => react(h.ctx, { objectId: target, message_block_id: "x", emoji: "" }),
			/emoji required/,
		);
	});
});

// ── list ─────────────────────────────────────────────────────────

describe("comment.list", () => {
	it("returns messages with reactions attached, ordered by created_at", async () => {
		const h = createHarness();
		const target = h.seedObject("page");
		const post = commentProgram.actor!.actions!.post;
		const react = commentProgram.actor!.actions!.react;
		const list = commentProgram.actor!.actions!.list;

		const a = await post(h.ctx, { objectId: target, text: "first" }) as { block_id: string };
		const b = await post(h.ctx, { objectId: target, text: "second" }) as { block_id: string };
		await react(h.ctx, { objectId: target, message_block_id: a.block_id, emoji: "👍" });
		await react(h.ctx, { objectId: target, message_block_id: a.block_id, emoji: "🔥" });

		const records = await list(h.ctx, { objectId: target }) as Array<any>;
		assert.equal(records.length, 2);
		assert.equal(records[0].block_id, a.block_id);
		assert.equal(records[0].text, "first");
		assert.equal(records[0].reactions.length, 2);
		assert.equal(records[1].block_id, b.block_id);
		assert.equal(records[1].reactions.length, 0);
	});

	it("rootsOnly excludes replies", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		const reply = commentProgram.actor!.actions!.reply;
		const list = commentProgram.actor!.actions!.list;

		const root = await post(h.ctx, { objectId: target, text: "root" }) as { block_id: string };
		await reply(h.ctx, { objectId: target, parent_block_id: root.block_id, text: "child" });
		await reply(h.ctx, { objectId: target, parent_block_id: root.block_id, text: "another child" });

		const all = await list(h.ctx, { objectId: target }) as Array<any>;
		assert.equal(all.length, 3);
		const roots = await list(h.ctx, { objectId: target, rootsOnly: true }) as Array<any>;
		assert.equal(roots.length, 1);
		assert.equal(roots[0].block_id, root.block_id);
	});

	it("returns [] for an object with no message blocks", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const list = commentProgram.actor!.actions!.list;
		const records = await list(h.ctx, { objectId: target }) as Array<any>;
		assert.equal(records.length, 0);
	});

	it("ignores non-message custom blocks (e.g. tool_use, compaction_summary on an agent)", async () => {
		const h = createHarness();
		const agentId = h.seedObject("agent");
		// Seed mixed blocks directly: agent-style tool_use + compaction_summary + a real message.
		const obj = h.objects.get(agentId)!;
		obj.blocks.push({
			id: "tu-1", timestamp: 1,
			content: { custom: { contentType: "tool_use", data: "", meta: { tool_name: "x" } } },
		});
		obj.blocks.push({
			id: "cs-1", timestamp: 2,
			content: { custom: { contentType: "compaction_summary", data: "", meta: { summary: "..." } } },
		});
		const post = commentProgram.actor!.actions!.post;
		await post(h.ctx, { objectId: agentId, text: "human comment on agent" });
		const list = commentProgram.actor!.actions!.list;
		const records = await list(h.ctx, { objectId: agentId }) as Array<any>;
		assert.equal(records.length, 1);
		assert.equal(records[0].text, "human comment on agent");
	});
});

// ── thread ───────────────────────────────────────────────────────

describe("comment.thread", () => {
	it("returns root + its descendants (BFS, by reply_to edges)", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const post = commentProgram.actor!.actions!.post;
		const reply = commentProgram.actor!.actions!.reply;
		const thread = commentProgram.actor!.actions!.thread;

		const root = await post(h.ctx, { objectId: target, text: "root" }) as { block_id: string };
		const a = await reply(h.ctx, { objectId: target, parent_block_id: root.block_id, text: "child A" }) as { block_id: string };
		const b = await reply(h.ctx, { objectId: target, parent_block_id: root.block_id, text: "child B" }) as { block_id: string };
		const a1 = await reply(h.ctx, { objectId: target, parent_block_id: a.block_id, text: "grandchild" }) as { block_id: string };
		// Sibling thread (different root) — should not be included.
		await post(h.ctx, { objectId: target, text: "unrelated" });

		const records = await thread(h.ctx, { objectId: target, root_block_id: root.block_id }) as Array<any>;
		const ids = records.map((r) => r.block_id);
		assert.equal(records.length, 4);
		assert.equal(ids[0], root.block_id);
		// BFS order: root, then immediate children sorted by created_at, then grandchildren.
		assert.ok(ids.indexOf(a.block_id) < ids.indexOf(a1.block_id), "parent before grandchild");
		assert.ok(ids.includes(b.block_id));
	});

	it("returns [] if the root_block_id doesn't exist on the object", async () => {
		const h = createHarness();
		const target = h.seedObject("chat");
		const thread = commentProgram.actor!.actions!.thread;
		const records = await thread(h.ctx, { objectId: target, root_block_id: "nope" }) as Array<any>;
		assert.equal(records.length, 0);
	});
});

// ── buildMessageRecords ──────────────────────────────────────────

describe("buildMessageRecords helper", () => {
	it("groups reactions by their target message", () => {
		const blocks = [
			{ id: "m1", content: { custom: { contentType: MESSAGE_CONTENT_TYPE, meta: { text: "hi", created_at: "100" } } } },
			{ id: "r1", content: { custom: { contentType: REACTION_CONTENT_TYPE, meta: { target: "m1", emoji: "👍", created_at: "200" } } } },
			{ id: "r2", content: { custom: { contentType: REACTION_CONTENT_TYPE, meta: { target: "m1", emoji: "🔥", created_at: "300" } } } },
			{ id: "m2", content: { custom: { contentType: MESSAGE_CONTENT_TYPE, meta: { text: "ok", created_at: "400" } } } },
		];
		const records = __test.buildMessageRecords(blocks);
		assert.equal(records.length, 2);
		assert.equal(records[0].block_id, "m1");
		assert.equal(records[0].reactions.length, 2);
		assert.deepEqual(records[0].reactions.map((r) => r.emoji).sort(), ["👍", "🔥"].sort());
		assert.equal(records[1].block_id, "m2");
		assert.equal(records[1].reactions.length, 0);
	});

	it("orphan reactions (target message missing) are silently dropped", () => {
		const blocks = [
			{ id: "r1", content: { custom: { contentType: REACTION_CONTENT_TYPE, meta: { target: "ghost", emoji: "👻" } } } },
			{ id: "m1", content: { custom: { contentType: MESSAGE_CONTENT_TYPE, meta: { text: "real", created_at: "100" } } } },
		];
		const records = __test.buildMessageRecords(blocks);
		assert.equal(records.length, 1);
		assert.equal(records[0].block_id, "m1");
		assert.equal(records[0].reactions.length, 0);
	});

	it("defends against malformed attachments JSON without throwing", () => {
		const blocks = [
			{ id: "m1", content: { custom: { contentType: MESSAGE_CONTENT_TYPE, meta: { text: "hi", attachments: "not json", created_at: "100" } } } },
		];
		const records = __test.buildMessageRecords(blocks);
		assert.equal(records.length, 1);
		assert.deepEqual(records[0].attachments, []);
	});
});
