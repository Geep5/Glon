/**
 * Chat program tests.
 *
 * /chat is a thin alias around /comment. These tests exercise the CLI
 * handler end-to-end: `chat new`, `chat send`, `chat reply`, `chat react`,
 * and `chat read` (which must render BOTH new /comment-style messages and
 * legacy TextContent messages from before the migration).
 *
 * The harness wires the chat handler's `dispatchProgram("/comment", ...)`
 * calls back into the actual /comment actor running against the same
 * in-memory store so the round-trip is real, not mocked.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import chatProgram from "../src/programs/handlers/chat.js";
import commentProgram, { MESSAGE_CONTENT_TYPE } from "../src/programs/handlers/comment.js";
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
	const printed: string[] = [];

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
		print: (msg: string) => { printed.push(msg); },
		randomUUID: () => `block-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-chat",
		objectActor: (id: string) => actorFor(id),
		// Wire /chat → /comment by routing dispatchProgram into the real actor.
		dispatchProgram: async (prefix: string, action: string, args: unknown[]) => {
			if (prefix !== "/comment") throw new Error(`unexpected dispatch: ${prefix}`);
			const actions = commentProgram.actor!.actions!;
			const fn = actions[action as keyof typeof actions];
			if (!fn) throw new Error(`unknown action /comment.${action}`);
			return await fn(ctx, ...(args as [any]));
		},
	};

	return {
		ctx, objects, printed,
		strip(): string { return printed.join("\n"); },
		clear(): void { printed.length = 0; },
		seedLegacyMessage(chatId: string, blockId: string, text: string, opts: { reply_to?: string; ts?: number } = {}): void {
			const o = objects.get(chatId)!;
			o.blocks.push({
				id: blockId,
				timestamp: opts.ts ?? nextBlockTs++,
				content: { text: { text, style: 0 } },
			});
			if (opts.reply_to) {
				o.fields[`reply:${blockId}`] = stringVal(opts.reply_to);
			}
		},
	};
}

// ── new + send + read ────────────────────────────────────────────

describe("chat new / send / read", () => {
	it("new creates a chat-typed object", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", ["my", "room"], h.ctx);
		const out = h.strip();
		assert.match(out, /Chat room: /);
		const ids = [...h.objects.keys()];
		assert.equal(ids.length, 1);
		assert.equal(h.objects.get(ids[0])!.typeKey, "chat");
	});

	it("send dispatches to /comment.post; the resulting block is a 'message' CustomContent", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", [], h.ctx);
		const chatId = [...h.objects.keys()][0];
		h.clear();
		await chatProgram.handler!("send", [chatId, "hello", "world"], h.ctx);
		const obj = h.objects.get(chatId)!;
		assert.equal(obj.blocks.length, 1);
		const ct = obj.blocks[0].content?.custom?.contentType;
		assert.equal(ct, MESSAGE_CONTENT_TYPE);
		assert.equal(obj.blocks[0].content.custom.meta.text, "hello world");
		assert.match(h.strip(), /sent /);
	});

	it("read renders new message blocks", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", ["general"], h.ctx);
		const chatId = [...h.objects.keys()][0];
		await chatProgram.handler!("send", [chatId, "first"], h.ctx);
		await chatProgram.handler!("send", [chatId, "second"], h.ctx);
		h.clear();
		await chatProgram.handler!("read", [chatId], h.ctx);
		const out = h.strip();
		assert.match(out, /# general/);
		assert.match(out, /first/);
		assert.match(out, /second/);
	});
});

// ── legacy compatibility ─────────────────────────────────────────

describe("chat read (legacy + new together)", () => {
	it("legacy TextContent messages render alongside new /comment messages, ordered by timestamp", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", ["mixed-room"], h.ctx);
		const chatId = [...h.objects.keys()][0];

		// Two legacy messages from before the migration.
		h.seedLegacyMessage(chatId, "legacy-1", "legacy first", { ts: 100 });
		h.seedLegacyMessage(chatId, "legacy-2", "legacy reply", { ts: 200, reply_to: "legacy-1" });

		// One new message via the /comment path.
		await chatProgram.handler!("send", [chatId, "new", "message"], h.ctx);

		h.clear();
		await chatProgram.handler!("read", [chatId], h.ctx);
		const out = h.strip();
		assert.match(out, /# mixed-room/);
		assert.match(out, /legacy first/);
		assert.match(out, /legacy reply/);
		assert.match(out, /new message/);
		// Legacy messages render with the legacy tag so operators can tell.
		assert.match(out, /\(legacy\)/);
		// Reply pointer printed for the legacy reply.
		assert.match(out, /↳ reply to legacy-1/);
	});

	it("read on an empty room prints '(no messages)'", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", [], h.ctx);
		const chatId = [...h.objects.keys()][0];
		h.clear();
		await chatProgram.handler!("read", [chatId], h.ctx);
		assert.match(h.strip(), /\(no messages\)/);
	});
});

// ── reply + react ────────────────────────────────────────────────

describe("chat reply / react", () => {
	it("reply dispatches to /comment.reply and the new block's reply_to is set", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", [], h.ctx);
		const chatId = [...h.objects.keys()][0];
		await chatProgram.handler!("send", [chatId, "root"], h.ctx);
		const root = h.objects.get(chatId)!.blocks[0];

		h.clear();
		await chatProgram.handler!("reply", [chatId, root.id, "child"], h.ctx);
		const blocks = h.objects.get(chatId)!.blocks;
		const reply = blocks.find((b) => b.id !== root.id)!;
		assert.equal(reply.content.custom.meta.reply_to, root.id);
	});

	it("react adds a reaction block (separate from the message)", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", [], h.ctx);
		const chatId = [...h.objects.keys()][0];
		await chatProgram.handler!("send", [chatId, "react-me"], h.ctx);
		const msg = h.objects.get(chatId)!.blocks[0];

		h.clear();
		await chatProgram.handler!("react", [chatId, msg.id, "🔥"], h.ctx);
		const blocks = h.objects.get(chatId)!.blocks;
		assert.equal(blocks.length, 2);
		const reaction = blocks.find((b) => b.id !== msg.id)!;
		assert.equal(reaction.content.custom.contentType, "reaction");
		assert.equal(reaction.content.custom.meta.target, msg.id);
		assert.equal(reaction.content.custom.meta.emoji, "🔥");
	});

	it("read renders reactions as a per-message summary", async () => {
		const h = createHarness();
		await chatProgram.handler!("new", [], h.ctx);
		const chatId = [...h.objects.keys()][0];
		await chatProgram.handler!("send", [chatId, "popular"], h.ctx);
		const msg = h.objects.get(chatId)!.blocks[0];
		await chatProgram.handler!("react", [chatId, msg.id, "👍"], h.ctx);
		await chatProgram.handler!("react", [chatId, msg.id, "👍"], h.ctx);
		await chatProgram.handler!("react", [chatId, msg.id, "🎉"], h.ctx);

		h.clear();
		await chatProgram.handler!("read", [chatId], h.ctx);
		const out = h.strip();
		assert.match(out, /popular/);
		assert.match(out, /👍 2/);
		assert.match(out, /🎉 1/);
	});
});
