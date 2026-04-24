/**
 * Discord bridge tests.
 *
 * Exercises the actor's poll + send paths. Discord REST is mocked via
 * globalThis.__DISCORD_FETCH. /peer and /gracie dispatches are mocked
 * via the same dispatchProgram harness used in the other tests.
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import discordProgram, { __test } from "../src/programs/handlers/discord.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

function clearDiscordMock() {
	delete (globalThis as any).__DISCORD_FETCH;
}

interface DiscordCall { method: string; path: string; body: unknown; }

function mockDiscord(handler: (call: DiscordCall) => any) {
	const calls: DiscordCall[] = [];
	(globalThis as any).__DISCORD_FETCH = async (call: DiscordCall) => {
		calls.push(call);
		return handler(call);
	};
	return calls;
}

function createHarness() {
	const peers = new Map<string, any>();
	const gracieReplies = new Map<string, string>(); // prompt text → response
	const dispatchCalls: { prefix: string; action: string; args: unknown[] }[] = [];

	const ctx: ProgramContext = {
		client: {},
		store: {
			get: async () => null,
			create: async () => "x",
			list: async () => [],
		},
		resolveId: async (p: string) => {
			if (peers.has(p)) return p;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => "uuid",
		state: {},
		emit: () => {},
		programId: "test-discord",
		objectActor: () => ({}),
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			if (prefix === "/peer" && action === "list") {
				return Array.from(peers.values());
			}
			if (prefix === "/peer" && action === "get") {
				const id = (args as [string])[0];
				return peers.get(id) ?? null;
			}
			if (prefix === "/gracie" && action === "ingest") {
				const [, , text] = args as [string, string, string];
				const reply = gracieReplies.get(text) ?? `echo:${text}`;
				return { finalText: reply, iterations: 1, toolCalls: 0, inputTokens: 10, outputTokens: 20, peer: { display_name: "x" } };
			}
			throw new Error(`unhandled dispatch: ${prefix} ${action}`);
		},
	};

	return {
		ctx,
		state: ctx.state,
		peers,
		gracieReplies,
		dispatchCalls,
		addPeer(peer: any) { peers.set(peer.id, peer); },
	};
}

// ── splitMessage ─────────────────────────────────────────────────

describe("splitMessage", () => {
	it("returns the input unchanged when under the limit", () => {
		assert.deepEqual(__test.splitMessage("hello"), ["hello"]);
	});

	it("splits at the last newline before the limit", () => {
		const input = "a\n" + "b".repeat(1500) + "\n" + "c".repeat(600);
		const parts = __test.splitMessage(input, 2000);
		assert.equal(parts.length, 2);
		assert.ok(parts[0].length <= 2000);
		assert.ok(parts[1].startsWith("c"));
	});

	it("hard-splits when no newline is available inside the limit", () => {
		const input = "x".repeat(5000);
		const parts = __test.splitMessage(input, 2000);
		assert.equal(parts.length, 3);
		assert.equal(parts[0].length, 2000);
		assert.equal(parts[1].length, 2000);
		assert.equal(parts[2].length, 1000);
	});
});

// ── send ─────────────────────────────────────────────────────────

describe("discord.send", () => {
	afterEach(clearDiscordMock);

	it("resolves peer, opens DM channel, posts message", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-mom", display_name: "Mom", kind: "human", trust_level: "family", discord_id: "999" });

		const calls = mockDiscord((call) => {
			if (call.method === "POST" && call.path === "/users/@me/channels") {
				return { id: "dm-channel-1" };
			}
			if (call.method === "POST" && call.path === "/channels/dm-channel-1/messages") {
				return { id: "msg-1" };
			}
			throw new Error(`unexpected call ${call.method} ${call.path}`);
		});

		const result = await __test.doSend("peer-mom", "hi mom", h.state, h.ctx) as { channel_id: string; message_ids: string[] };
		assert.equal(result.channel_id, "dm-channel-1");
		assert.deepEqual(result.message_ids, ["msg-1"]);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].path, "/users/@me/channels");
		assert.deepEqual(calls[0].body, { recipient_id: "999" });
		assert.deepEqual(calls[1].body, { content: "hi mom" });
	});

	it("caches DM channel and skips reopen on second send", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-mom", display_name: "Mom", discord_id: "999", kind: "human", trust_level: "family" });

		const calls = mockDiscord((call) => {
			if (call.path === "/users/@me/channels") return { id: "ch-1" };
			if (call.path.startsWith("/channels/ch-1/messages")) return { id: "m-" + calls.length };
			return null;
		});

		await __test.doSend("peer-mom", "one", h.state, h.ctx);
		await __test.doSend("peer-mom", "two", h.state, h.ctx);

		const opens = calls.filter((c) => c.path === "/users/@me/channels");
		assert.equal(opens.length, 1, "DM channel should be opened exactly once");
	});

	it("splits long text into multiple posts", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-mom", display_name: "Mom", discord_id: "999", kind: "human", trust_level: "family" });
		const long = "a".repeat(4500); // 3 chunks of ≤2000

		let posted = 0;
		mockDiscord((call) => {
			if (call.path === "/users/@me/channels") return { id: "ch-1" };
			if (call.path.startsWith("/channels/ch-1/messages")) {
				posted++;
				return { id: `m-${posted}` };
			}
			return null;
		});

		const result = await __test.doSend("peer-mom", long, h.state, h.ctx) as { message_ids: string[] };
		assert.equal(result.message_ids.length, 3);
	});

	it("throws when peer has no discord_id", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-mom", display_name: "Mom", kind: "human", trust_level: "family" });
		mockDiscord(() => null);
		await assert.rejects(
			() => __test.doSend("peer-mom", "hi", h.state, h.ctx),
			/no discord_id/,
		);
	});

	it("throws when peer is unknown", async () => {
		const h = createHarness();
		mockDiscord(() => null);
		await assert.rejects(
			() => __test.doSend("nope", "hi", h.state, h.ctx),
			/unknown peer/,
		);
	});
});

// ── polling ──────────────────────────────────────────────────────

describe("discord polling", () => {
	afterEach(clearDiscordMock);

	it("first tick per channel seeds watermark without processing (no replay)", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });

		h.state.botUserId = "bot-id";
		mockDiscord((call) => {
			if (call.path === "/users/@me/channels") return { id: "ch-1" };
			if (call.path.startsWith("/channels/ch-1/messages")) {
				return [{ id: "100", author: { id: "111" }, content: "historical msg" }];
			}
			return null;
		});

		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.processed, 0);
		assert.equal((h.state.watermarks as any)["ch-1"], "100");
		// No ingest dispatched.
		assert.equal(h.dispatchCalls.filter((c) => c.action === "ingest").length, 0);
	});

	it("second tick with new messages ingests via /gracie and sends reply", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.state.dmChannelByPeer = { "peer-grant": "ch-1" };
		h.state.watermarks = { "ch-1": "100" };

		h.gracieReplies.set("hello", "hi grant");

		let postedContent = "";
		mockDiscord((call) => {
			if (call.path.startsWith("/channels/ch-1/messages?")) {
				return [{ id: "101", author: { id: "111" }, content: "hello" }];
			}
			if (call.method === "POST" && call.path === "/channels/ch-1/messages") {
				postedContent = (call.body as any).content;
				return { id: "102" };
			}
			if (call.path === "/channels/ch-1/typing") return null;
			return null;
		});

		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.processed, 1);
		assert.equal(postedContent, "hi grant");
		assert.equal((h.state.watermarks as any)["ch-1"], "101");

		const ingest = h.dispatchCalls.find((c) => c.action === "ingest");
		assert.ok(ingest);
		assert.deepEqual(ingest!.args, ["discord", "peer-grant", "hello"]);
	});

	it("skips messages authored by the bot itself", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.state.dmChannelByPeer = { "peer-grant": "ch-1" };
		h.state.watermarks = { "ch-1": "100" };

		mockDiscord((call) => {
			if (call.path.startsWith("/channels/ch-1/messages?")) {
				return [
					{ id: "101", author: { id: "bot-id" }, content: "my own reply" },
					{ id: "102", author: { id: "111" }, content: "real question" },
				];
			}
			if (call.method === "POST" && call.path === "/channels/ch-1/messages") return { id: "m" };
			if (call.path === "/channels/ch-1/typing") return null;
			return null;
		});

		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.processed, 1);
		const ingests = h.dispatchCalls.filter((c) => c.action === "ingest");
		assert.equal(ingests.length, 1);
		assert.equal((ingests[0].args as any[])[2], "real question");
	});

	it("skips peers without discord_id silently", async () => {
		const h = createHarness();
		// list() filters these out but double-check: peers with no discord_id shouldn't trigger any calls.
		h.addPeer({ id: "peer-local", display_name: "LocalFriend", kind: "human", trust_level: "family" });

		const calls = mockDiscord(() => null);
		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.peers, 0);
		assert.equal(r.processed, 0);
		assert.equal(calls.length, 0);
	});

	it("tick reentrancy guard: ongoing onTick sets tickInProgress", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		process.env.DISCORD_BOT_TOKEN = "test-token";
		h.state.tickInProgress = true;

		let called = 0;
		mockDiscord(() => { called++; return null; });

		await discordProgram.actor!.onTick!(h.ctx);
		assert.equal(called, 0, "should not poll while tickInProgress=true");
		// State left as-is by caller
		assert.equal(h.state.tickInProgress, true);
	});
});
