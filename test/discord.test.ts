/**
 * Discord bridge tests.
 *
 * Exercises the actor's poll + send paths. Discord REST is mocked via
 * globalThis.__DISCORD_FETCH. /peer and /holdfast dispatches are mocked
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
	const harnessReplies = new Map<string, string>(); // prompt text -> response
	const dispatchCalls: { prefix: string; action: string; args: unknown[] }[] = [];

	// Fields shared by ctx.store.get (read side) and ctx.objectActor().setField
	// (write side), so tests can exercise persist-then-restore round-trips
	// without a real RivetKit instance.
	const PROGRAM_ID = "test-discord";
	const storedFields: Record<string, unknown> = {};
	const actorCalls: { id: string; key: string; valueJson: string }[] = [];

	const ctx: ProgramContext = {
		client: {},
		store: {
			get: async (id: string) => {
				if (id === PROGRAM_ID) return { id, fields: { ...storedFields } };
				return null;
			},
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
		programId: PROGRAM_ID,
		objectActor: (id: string) => ({
			setField: async (key: string, valueJson: string) => {
				actorCalls.push({ id, key, valueJson });
				if (id === PROGRAM_ID) storedFields[key] = JSON.parse(valueJson);
			},
		}),
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			if (prefix === "/peer" && action === "list") {
				return Array.from(peers.values());
			}
			if (prefix === "/peer" && action === "get") {
				const id = (args as [string])[0];
				return peers.get(id) ?? null;
			}
			if (prefix === "/holdfast" && action === "ingest") {
				const [, , text] = args as [string, string, string];
				const reply = harnessReplies.get(text) ?? `echo:${text}`;
				return { finalText: reply, iterations: 1, toolCalls: 0, inputTokens: 10, outputTokens: 20, peer: { display_name: "x" } };
			}
			throw new Error(`unhandled dispatch: ${prefix} ${action}`);
		},
	};

	return {
		ctx,
		state: ctx.state,
		peers,
		harnessReplies,
		dispatchCalls,
		storedFields,
		actorCalls,
		PROGRAM_ID,
		addPeer(peer: any) { peers.set(peer.id, peer); },
		/** Seed `storedFields[key]` with a raw string — simulates a prior daemon run. */
		seedStoredField(key: string, raw: string) {
			storedFields[key] = stringVal(raw);
		},
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

	// Snowflake timestamp = (unix_ms - 1420070400000) << 22. Build one for "now"
	// so the first-poll recency check lets it through.
	function freshSnowflake(offsetMs = 0): string {
		return ((BigInt(Date.now() - offsetMs) - 1420070400000n) << 22n).toString();
	}

	it("first tick skips messages older than the recency window", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });

		h.state.botUserId = "bot-id";
		mockDiscord((call) => {
			if (call.path === "/users/@me/channels") return { id: "ch-1" };
			if (call.path.startsWith("/channels/ch-1/messages")) {
				// Snowflake "100" resolves to Jan 2015 — well outside the 15-minute window.
				return [{ id: "100", author: { id: "111" }, content: "historical msg" }];
			}
			return null;
		});

		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.processed, 0);
		assert.equal((h.state.watermarks as any)["ch-1"], "100", "watermark advances so next tick only sees newer traffic");
		assert.equal(h.dispatchCalls.filter((c) => c.action === "ingest").length, 0);
	});

	it("first tick processes a recent message so an onboarding DM isn't dropped", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.harnessReplies.set("hi nova", "hi grant");

		const recentId = freshSnowflake(5_000); // 5s ago
		let postedContent = "";
		mockDiscord((call) => {
			if (call.path === "/users/@me/channels") return { id: "ch-1" };
			if (call.path.startsWith("/channels/ch-1/messages?")) {
				return [{ id: recentId, author: { id: "111" }, content: "hi nova" }];
			}
			if (call.method === "POST" && call.path === "/channels/ch-1/messages") {
				postedContent = (call.body as any).content;
				return { id: "reply" };
			}
			if (call.path === "/channels/ch-1/typing") return null;
			return null;
		});

		const r = await __test.runPoll(h.state, h.ctx);
		assert.equal(r.processed, 1);
		assert.equal(postedContent, "hi grant");
		assert.equal((h.state.watermarks as any)["ch-1"], recentId);
	});

	it("second tick with new messages ingests via /holdfast and sends reply", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.state.dmChannelByPeer = { "peer-grant": "ch-1" };
		h.state.watermarks = { "ch-1": "100" };

		h.harnessReplies.set("hello", "hi grant");

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

// ── Durable state (watermarks survive daemon restart) ──────────

describe("discord durable state", () => {
	afterEach(() => { clearDiscordMock(); delete process.env.DISCORD_BOT_TOKEN; });

	it("FIRST_POLL_RECENCY_MS is 60s — the persisted-watermark fix lets us shrink it", () => {
		assert.equal(__test.FIRST_POLL_RECENCY_MS, 60 * 1000);
	});

	it("snapshotPersistedState only includes durable fields, never gateway/in-flight state", () => {
		const raw = __test.snapshotPersistedState({
			watermarks: { "ch-1": "123" },
			dmChannelByPeer: { "peer-a": "ch-1" },
			botUserId: "bot",
			tickInProgress: true,
			gatewayConnected: true,
		});
		assert.deepEqual(JSON.parse(raw), {
			watermarks: { "ch-1": "123" },
			dmChannelByPeer: { "peer-a": "ch-1" },
		});
	});

	it("restorePersistedState rehydrates state from a prior daemon run", async () => {
		const h = createHarness();
		h.seedStoredField(__test.PERSISTED_STATE_FIELD, JSON.stringify({
			watermarks: { "ch-1": "99999" },
			dmChannelByPeer: { "peer-grant": "ch-1" },
		}));
		await __test.restorePersistedState(h.state, h.ctx);
		assert.deepEqual(h.state.watermarks, { "ch-1": "99999" });
		assert.deepEqual(h.state.dmChannelByPeer, { "peer-grant": "ch-1" });
	});

	it("restorePersistedState is a silent no-op when the program object has no field yet", async () => {
		const h = createHarness();
		await __test.restorePersistedState(h.state, h.ctx);
		assert.equal(h.state.watermarks, undefined);
		assert.equal(h.state.dmChannelByPeer, undefined);
	});

	it("persistStateIfChanged writes through objectActor.setField when the snapshot changes", async () => {
		const h = createHarness();
		h.state.watermarks = { "ch-1": "100" };
		h.state.dmChannelByPeer = { "peer-a": "ch-1" };
		await __test.persistStateIfChanged(h.state, h.ctx);
		assert.equal(h.actorCalls.length, 1);
		assert.equal(h.actorCalls[0].id, h.PROGRAM_ID);
		assert.equal(h.actorCalls[0].key, __test.PERSISTED_STATE_FIELD);
		const written = JSON.parse(h.actorCalls[0].valueJson) as any;
		const payload = JSON.parse(written.stringValue);
		assert.deepEqual(payload.watermarks, { "ch-1": "100" });
	});

	it("persistStateIfChanged is a no-op on the second call when nothing changed", async () => {
		const h = createHarness();
		h.state.watermarks = { "ch-1": "100" };
		await __test.persistStateIfChanged(h.state, h.ctx);
		await __test.persistStateIfChanged(h.state, h.ctx);
		await __test.persistStateIfChanged(h.state, h.ctx);
		assert.equal(h.actorCalls.length, 1, "only the first call hits the actor");
	});

	it("persist → restart → restore preserves the watermark across a simulated daemon bounce", async () => {
		const h = createHarness();
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.state.dmChannelByPeer = { "peer-grant": "ch-1" };
		h.state.watermarks = { "ch-1": "100" };
		h.harnessReplies.set("hello", "hi grant");

		let posted = 0;
		mockDiscord((call) => {
			if (call.path.startsWith("/channels/ch-1/messages?")) {
				return [{ id: "101", author: { id: "111" }, content: "hello" }];
			}
			if (call.method === "POST" && call.path === "/channels/ch-1/messages") {
				posted++;
				return { id: "reply" };
			}
			if (call.path === "/channels/ch-1/typing") return null;
			return null;
		});

		const r1 = await __test.runPoll(h.state, h.ctx);
		assert.equal(r1.processed, 1);
		await __test.persistStateIfChanged(h.state, h.ctx);
		assert.equal(posted, 1, "first poll posts one reply");

		// Simulate daemon bounce: drop the in-memory state, keep the same store-backed
		// fields. After restore the watermark should already be at 101, so the next
		// runPoll over the same Discord history must not re-ingest "hello".
		h.ctx.state = {} as any;
		await __test.restorePersistedState(h.ctx.state, h.ctx);
		assert.deepEqual((h.ctx.state as any).watermarks, { "ch-1": "101" });
		assert.deepEqual((h.ctx.state as any).dmChannelByPeer, { "peer-grant": "ch-1" });

		const r2 = await __test.runPoll(h.ctx.state, h.ctx);
		assert.equal(r2.processed, 0, "already-handled message must not be re-ingested after restart");
		assert.equal(posted, 1, "no second reply");
	});

	it("poll action returns tick-in-progress sentinel and skips work when a tick is running", async () => {
		const h = createHarness();
		process.env.DISCORD_BOT_TOKEN = "test-token";
		h.state.tickInProgress = true;

		let called = 0;
		mockDiscord(() => { called++; return null; });

		const result = await discordProgram.actor!.actions!.poll!(h.ctx) as any;
		assert.equal(called, 0, "poll action must not race a running tick");
		assert.equal(result.skipped, "tick-in-progress");
		assert.equal(h.state.tickInProgress, true, "caller's flag is left untouched");
	});

	it("poll action persists state after a successful run", async () => {
		const h = createHarness();
		process.env.DISCORD_BOT_TOKEN = "test-token";
		h.addPeer({ id: "peer-grant", display_name: "Grant", discord_id: "111", kind: "self", trust_level: "self" });
		h.state.botUserId = "bot-id";
		h.state.dmChannelByPeer = { "peer-grant": "ch-1" };
		h.state.watermarks = { "ch-1": "100" };
		h.harnessReplies.set("new", "ack");

		mockDiscord((call) => {
			if (call.path.startsWith("/channels/ch-1/messages?")) {
				return [{ id: "200", author: { id: "111" }, content: "new" }];
			}
			if (call.method === "POST" && call.path === "/channels/ch-1/messages") return { id: "x" };
			if (call.path === "/channels/ch-1/typing") return null;
			return null;
		});

		await discordProgram.actor!.actions!.poll!(h.ctx);
		const writes = h.actorCalls.filter((c) => c.key === __test.PERSISTED_STATE_FIELD);
		assert.equal(writes.length, 1, "poll action persists exactly once after the run");
		const payload = JSON.parse(JSON.parse(writes[0].valueJson).stringValue);
		assert.equal(payload.watermarks["ch-1"], "200");
	});
});


// ── Gateway (presence) ────────────────────────────────────

describe("buildIdentifyPayload", () => {
	it("packs token, zero intents, and online presence", () => {
		const p = __test.buildIdentifyPayload("test-token") as any;
		assert.equal(p.op, 2);
		assert.equal(p.d.token, "test-token");
		assert.equal(p.d.intents, 0, "no intents needed for presence-only");
		assert.equal(p.d.presence.status, "online");
		assert.ok(Array.isArray(p.d.presence.activities) && p.d.presence.activities.length === 1);
	});
});

describe("computeReconnectDelayMs", () => {
	it("grows exponentially from 1s, caps at 30s", () => {
		// Deterministic random = 0.5 => jitter multiplier = 1.0 (exact base)
		const r = () => 0.5;
		assert.equal(__test.computeReconnectDelayMs(1, r), 1_000);
		assert.equal(__test.computeReconnectDelayMs(2, r), 2_000);
		assert.equal(__test.computeReconnectDelayMs(3, r), 4_000);
		assert.equal(__test.computeReconnectDelayMs(4, r), 8_000);
		assert.equal(__test.computeReconnectDelayMs(5, r), 16_000);
		assert.equal(__test.computeReconnectDelayMs(6, r), 30_000);
		assert.equal(__test.computeReconnectDelayMs(10, r), 30_000, "caps");
	});
	it("jitters within \u00b125% of the base", () => {
		const low = __test.computeReconnectDelayMs(3, () => 0);
		const high = __test.computeReconnectDelayMs(3, () => 1);
		assert.equal(low, 3_000);  // 4000 * 0.75
		assert.equal(high, 5_000); // 4000 * 1.25
	});
});

describe("shouldSendHeartbeat", () => {
	it("false until we're connected and have an interval", () => {
		assert.equal(__test.shouldSendHeartbeat({}, 0), false);
		assert.equal(__test.shouldSendHeartbeat({ gatewayHeartbeatMs: 1000 }, 0), false);
		assert.equal(__test.shouldSendHeartbeat({ gatewayConnected: true }, 0), false);
	});
	it("true once an interval has elapsed since last send", () => {
		const state: any = { gatewayConnected: true, gatewayHeartbeatMs: 1000, gatewayLastHeartbeatSentAt: 0 };
		assert.equal(__test.shouldSendHeartbeat(state, 999), false);
		assert.equal(__test.shouldSendHeartbeat(state, 1000), true);
		assert.equal(__test.shouldSendHeartbeat(state, 5000), true);
	});
});

describe("isHeartbeatAckOverdue", () => {
	it("false when the server has ack'd our latest heartbeat", () => {
		const state: any = {
			gatewayConnected: true,
			gatewayHeartbeatMs: 1000,
			gatewayLastHeartbeatSentAt: 1000,
			gatewayLastHeartbeatAckAt: 1100,
		};
		assert.equal(__test.isHeartbeatAckOverdue(state, 5000), false);
	});
	it("true once two intervals pass with no ack", () => {
		const state: any = {
			gatewayConnected: true,
			gatewayHeartbeatMs: 1000,
			gatewayLastHeartbeatSentAt: 1000,
			gatewayLastHeartbeatAckAt: 0,
		};
		assert.equal(__test.isHeartbeatAckOverdue(state, 2999), false, "<2x");
		assert.equal(__test.isHeartbeatAckOverdue(state, 3000), true, ">=2x");
	});
});

describe("shouldReconnectOnClose", () => {
	it("retries transient close codes", () => {
		assert.equal(__test.shouldReconnectOnClose(1000), true);
		assert.equal(__test.shouldReconnectOnClose(1006), true);
		assert.equal(__test.shouldReconnectOnClose(4000), true); // "unknown error"
		assert.equal(__test.shouldReconnectOnClose(4009), true); // session timed out
	});
	it("gives up on auth / configuration failures", () => {
		assert.equal(__test.shouldReconnectOnClose(4004), false, "auth failed");
		assert.equal(__test.shouldReconnectOnClose(4013), false, "invalid intents");
		assert.equal(__test.shouldReconnectOnClose(4014), false, "disallowed intents");
	});
});

describe("handleGatewayFrame", () => {
	it("HELLO captures interval and prompts IDENTIFY", () => {
		const state: any = {};
		const a = __test.handleGatewayFrame(state, { op: 10, d: { heartbeat_interval: 41250 } }, 1000);
		assert.equal(state.gatewayHeartbeatMs, 41250);
		assert.equal(a.sendIdentify, true);
	});
	it("HEARTBEAT_ACK records time", () => {
		const state: any = {};
		__test.handleGatewayFrame(state, { op: 11 }, 5000);
		assert.equal(state.gatewayLastHeartbeatAckAt, 5000);
	});
	it("DISPATCH READY marks identified and resets backoff", () => {
		const state: any = { gatewayReconnectAttempts: 5 };
		__test.handleGatewayFrame(state, { op: 0, s: 1, t: "READY", d: { user: { id: "bot-123" } } }, 0);
		assert.equal(state.gatewayIdentified, true);
		assert.equal(state.gatewayReconnectAttempts, 0);
		assert.equal(state.botUserId, "bot-123");
		assert.equal(state.gatewayLastSeq, 1);
	});
	it("DISPATCH non-READY still tracks sequence", () => {
		const state: any = {};
		__test.handleGatewayFrame(state, { op: 0, s: 7, t: "MESSAGE_CREATE", d: {} }, 0);
		assert.equal(state.gatewayLastSeq, 7);
		assert.ok(!state.gatewayIdentified);
	});
	it("OP_RECONNECT and OP_INVALID_SESSION ask caller to reconnect", () => {
		const s1 = __test.handleGatewayFrame({} as any, { op: 7 }, 0);
		assert.equal(s1.reconnect, true);
		const s2 = __test.handleGatewayFrame({} as any, { op: 9, d: false }, 0);
		assert.equal(s2.reconnect, true);
	});
	it("server-requested HEARTBEAT triggers immediate send", () => {
		const a = __test.handleGatewayFrame({} as any, { op: 1 }, 0);
		assert.equal(a.sendHeartbeat, true);
	});
});

// ── Gateway end-to-end: connect → HELLO → IDENTIFY → READY ────────────

/**
 * Minimal WebSocket double. Lets tests drive the actor's handlers synchronously.
 */
class FakeWS {
	readyState = 0;
	sent: string[] = [];
	onopen: ((e?: any) => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: ((e: { code: number; reason: string }) => void) | null = null;
	onerror: ((e: any) => void) | null = null;
	constructor(public url: string) { FakeWS.last = this; }
	send(data: string): void { this.sent.push(data); }
	close(code = 1000, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	static last: FakeWS | null = null;
}

async function withFakeWS(run: () => Promise<void> | void): Promise<void> {
	(globalThis as any).__DISCORD_GATEWAY_WS_CTOR = FakeWS;
	FakeWS.last = null;
	try { await run(); }
	finally { delete (globalThis as any).__DISCORD_GATEWAY_WS_CTOR; }
}

describe("gateway lifecycle", () => {
	it("onCreate opens WS; HELLO triggers IDENTIFY; READY marks identified", async () => {
		process.env.DISCORD_BOT_TOKEN = "test-token";
		await withFakeWS(async () => {
			const h = createHarness();
			mockDiscord((call) => {
				if (call.path === "/users/@me") return { id: "bot-123" };
				return null;
			});
			await discordProgram.actor!.onCreate!(h.ctx);

			const ws = FakeWS.last!;
			assert.ok(ws, "WS constructed");
			assert.match(ws.url, /gateway\.discord\.gg/);

			ws.onopen?.();
			assert.equal(h.state.gatewayConnected, true);

			// Server sends HELLO → actor should emit IDENTIFY
			ws.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
			assert.equal(h.state.gatewayHeartbeatMs, 41250);
			assert.equal(ws.sent.length, 1);
			const identify = JSON.parse(ws.sent[0]);
			assert.equal(identify.op, 2);
			assert.equal(identify.d.token, "test-token");

			// Server sends READY
			ws.onmessage?.({ data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-123" } } }) });
			assert.equal(h.state.gatewayIdentified, true);
			assert.equal(h.state.botUserId, "bot-123");
		});
	});

	it("onTick sends heartbeat when due, records send time", async () => {
		process.env.DISCORD_BOT_TOKEN = "test-token";
		await withFakeWS(async () => {
			const h = createHarness();
			mockDiscord((call) => {
				if (call.path === "/users/@me") return { id: "bot-123" };
				return null;
			});
			await discordProgram.actor!.onCreate!(h.ctx);
			const ws = FakeWS.last!;
			ws.onopen?.();
			ws.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 1 } }) });
			ws.onmessage?.({ data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-123" } } }) });
			ws.sent = []; // clear IDENTIFY from sent

			await new Promise((resolve) => setTimeout(resolve, 5));
			__test.tickGateway(h.state, h.ctx);
			assert.equal(ws.sent.length, 1, "heartbeat emitted");
			const hb = JSON.parse(ws.sent[0]);
			assert.equal(hb.op, 1);
			assert.equal(hb.d, 1, "heartbeat carries last sequence number");
			assert.ok(h.state.gatewayLastHeartbeatSentAt > 0);
		});
	});

	it("close with fatal code (4004) stops reconnecting", async () => {
		process.env.DISCORD_BOT_TOKEN = "test-token";
		await withFakeWS(async () => {
			const h = createHarness();
			mockDiscord(() => ({ id: "bot" }));
			await discordProgram.actor!.onCreate!(h.ctx);
			const ws = FakeWS.last!;
			ws.onclose?.({ code: 4004, reason: "bad token" });
			assert.equal(h.state.gatewayFatal, true);
			assert.equal(h.state.gatewayWs, null);
		});
	});

	it("close with transient code schedules reconnect", async () => {
		process.env.DISCORD_BOT_TOKEN = "test-token";
		await withFakeWS(async () => {
			const h = createHarness();
			mockDiscord(() => ({ id: "bot" }));
			await discordProgram.actor!.onCreate!(h.ctx);
			const ws = FakeWS.last!;
			ws.onclose?.({ code: 1006, reason: "abnormal" });
			assert.ok(!h.state.gatewayFatal);
			assert.ok(h.state.gatewayNextReconnectAt > 0, "next reconnect scheduled");
			assert.equal(h.state.gatewayReconnectAttempts, 1);
		});
	});

	it("onDestroy closes the WS cleanly", async () => {
		process.env.DISCORD_BOT_TOKEN = "test-token";
		await withFakeWS(async () => {
			const h = createHarness();
			mockDiscord(() => ({ id: "bot" }));
			await discordProgram.actor!.onCreate!(h.ctx);
			const ws = FakeWS.last!;
			assert.equal(ws.readyState, 0);
			await discordProgram.actor!.onDestroy!(h.ctx);
			assert.equal(ws.readyState, 3, "close() was called");
			assert.equal(h.state.gatewayWs, null);
		});
	});
});
