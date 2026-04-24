/**
 * Reminder scheduler tests.
 *
 * Covers schedule, list, cancel, get, and the scheduler tick — including
 * idempotency guard, channel dispatch routing, failure handling, and
 * filtering.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import remindProgram, { __test, CHANNELS } from "../src/programs/handlers/remind.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredObj>();
	const dispatchCalls: { prefix: string; action: string; args: unknown[] }[] = [];
	const dispatchHandlers = new Map<string, (args: unknown[]) => unknown>();
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
			markDeleted: async () => {
				const obj = objects.get(id);
				if (obj) obj.deleted = true;
			},
			addBlock: async () => { /* unused */ },
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id);
			if (!o) return null;
			return {
				id, typeKey: o.typeKey, fields: o.fields, deleted: o.deleted,
				blocks: [], blockProvenance: {}, content: "",
				createdAt: 0, updatedAt: 0, headIds: [], changeCount: 0,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `${typeKey}-${nextId++}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, deleted: false });
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
		randomUUID: () => `uuid-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-remind",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`no dispatch handler for ${key}`);
			return handler(args);
		},
	};

	return {
		ctx, objects, dispatchCalls,
		onDispatch(prefix: string, action: string, fn: (args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, fn);
		},
	};
}

// ── parseFireAt ──────────────────────────────────────────────────

describe("parseFireAt", () => {
	it("parses ISO strings", () => {
		const ms = __test.parseFireAt("2030-04-24T15:00:00Z");
		assert.ok(ms > 0);
		assert.equal(ms, Date.parse("2030-04-24T15:00:00Z"));
	});

	it("parses relative shorthand", () => {
		const before = Date.now();
		const ms = __test.parseFireAt("+5m");
		const after = Date.now();
		assert.ok(ms >= before + 5 * 60_000);
		assert.ok(ms <= after + 5 * 60_000 + 100);
	});

	it("accepts raw numbers as epoch ms", () => {
		assert.equal(__test.parseFireAt(12345), 12345);
	});

	it("rejects garbage", () => {
		assert.throws(() => __test.parseFireAt("not-a-date"), /invalid fire_at/);
	});
});

// ── schedule ─────────────────────────────────────────────────────

describe("schedule", () => {
	it("creates a reminder object with correctly-shaped fields", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "discord",
			target: "peer-grant",
			fire_at: "+10m",
			payload: { message: "call Sarah" },
			created_by: "peer-grant",
			note: "sarah-call",
		}) as { id: string; fire_at_ms: number };

		const obj = h.objects.get(r.id)!;
		assert.equal(obj.typeKey, "reminder");
		assert.equal(obj.fields.channel.stringValue, "discord");
		assert.equal(obj.fields.target.stringValue, "peer-grant");
		assert.equal(obj.fields.status.stringValue, "pending");
		assert.equal(obj.fields.created_by.stringValue, "peer-grant");
		assert.equal(obj.fields.note.stringValue, "sarah-call");
		const payload = JSON.parse(obj.fields.payload.stringValue);
		assert.deepEqual(payload, { message: "call Sarah" });
		assert.ok(obj.fields.fire_at_ms.intValue > Date.now());
		assert.ok(obj.fields.created_at_ms.intValue <= Date.now());
	});

	it("rejects unknown channels", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		await assert.rejects(
			() => schedule(h.ctx, { channel: "sms", target: "x", fire_at: "+1m" }),
			/unknown channel/,
		);
	});

	it("defaults created_by to 'system' when omitted", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "discord", target: "peer-x", fire_at: "+1h",
			payload: { message: "x" },
		}) as { id: string };
		const obj = h.objects.get(r.id)!;
		assert.equal(obj.fields.created_by.stringValue, "system");
	});
});

// ── list + get + cancel ──────────────────────────────────────────

describe("list / get / cancel", () => {
	it("list returns records sorted by fire_at_ms", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const list = remindProgram.actor!.actions!.list;

		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+2h", payload: { message: "later" } });
		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+1h", payload: { message: "middle" } });
		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+30m", payload: { message: "soon" } });

		const records = await list(h.ctx) as Array<{ payload: { message: string } }>;
		assert.equal(records.length, 3);
		assert.equal(records[0].payload.message, "soon");
		assert.equal(records[1].payload.message, "middle");
		assert.equal(records[2].payload.message, "later");
	});

	it("list filters by status / peer / channel / before", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		const list = remindProgram.actor!.actions!.list;

		const a = await schedule(h.ctx, { channel: "discord", target: "grant", fire_at: "+1h", payload: {}, created_by: "grant" }) as { id: string };
		const b = await schedule(h.ctx, { channel: "email", target: "mom@ex.com", fire_at: "+2h", payload: {}, created_by: "grant" }) as { id: string };
		await schedule(h.ctx, { channel: "discord", target: "mom", fire_at: "+3h", payload: {}, created_by: "mom" });
		await cancel(h.ctx, a.id);

		const pending = await list(h.ctx, { status: "pending" }) as Array<{ id: string }>;
		assert.equal(pending.length, 2);
		assert.ok(!pending.find((r) => r.id === a.id));

		const email = await list(h.ctx, { channel: "email" }) as Array<{ id: string }>;
		assert.equal(email.length, 1);
		assert.equal(email[0].id, b.id);

		const grantOnly = await list(h.ctx, { peer_id: "grant" }) as Array<unknown>;
		// `a` (created_by grant, cancelled) + `b` (created_by grant) match by created_by;
		// the mom one doesn't match.
		assert.equal(grantOnly.length, 2);
	});

	it("get returns full record or null", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const get = remindProgram.actor!.actions!.get;
		const r = await schedule(h.ctx, { channel: "discord", target: "x", fire_at: "+1h", payload: { message: "hi" } }) as { id: string };
		const rec = await get(h.ctx, r.id) as { id: string; payload: { message: string } };
		assert.equal(rec.id, r.id);
		assert.equal(rec.payload.message, "hi");

		assert.equal(await get(h.ctx, "nope"), null);
	});

	it("cancel marks pending reminders cancelled; noop on non-pending", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		const r = await schedule(h.ctx, { channel: "discord", target: "x", fire_at: "+1h", payload: {} }) as { id: string };
		const result1 = await cancel(h.ctx, r.id) as { ok: boolean; was: string };
		assert.equal(result1.ok, true);
		assert.equal(result1.was, "pending");
		// Second cancel is a noop.
		const result2 = await cancel(h.ctx, r.id) as { ok: boolean; was: string };
		assert.equal(result2.ok, false);
		assert.equal(result2.was, "cancelled");
	});
});

// ── runSchedulerTick ─────────────────────────────────────────────

describe("runSchedulerTick", () => {
	it("fires only due + pending reminders via the right dispatcher", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		// Mock downstream programs.
		let discordSends = 0;
		let gracieCompositions = 0;
		h.onDispatch("/discord", "send", (args) => {
			discordSends++;
			const inp = (args as [any])[0];
			assert.equal(inp.peer_id, "grant");
			assert.equal(inp.text, "wake up");
			return { channel_id: "ch", message_ids: ["m"] };
		});
		h.onDispatch("/gracie", "ingest", (args) => {
			gracieCompositions++;
			const [source, peer, text] = args as [string, string, string];
			assert.equal(source, "scheduler");
			assert.equal(peer, "grant");
			assert.match(text, /think about dinner/);
			return { finalText: "ok", iterations: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, peer: { display_name: "grant" } };
		});

		// Due: one discord, one gracie_compose. Not due: one in the future.
		const dueDiscord = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 60_000, // 1 min ago
			payload: { message: "wake up" },
		}) as { id: string };
		const dueGracie = await schedule(h.ctx, {
			channel: "gracie_compose", target: "grant",
			fire_at: Date.now() - 30_000,
			payload: { prompt: "think about dinner" },
		}) as { id: string };
		const notDue = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() + 3_600_000, // 1h ahead
			payload: { message: "later" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(discordSends, 1);
		assert.equal(gracieCompositions, 1);
		assert.equal(result.fired, 2);
		assert.equal(result.failed, 0);

		// Status transitions.
		assert.equal(h.objects.get(dueDiscord.id)!.fields.status.stringValue, "sent");
		assert.equal(h.objects.get(dueGracie.id)!.fields.status.stringValue, "sent");
		assert.equal(h.objects.get(notDue.id)!.fields.status.stringValue, "pending");
		assert.ok(h.objects.get(dueDiscord.id)!.fields.sent_at_ms.intValue > 0);
	});

	it("records last_error and status=failed when the dispatcher throws", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		h.onDispatch("/discord", "send", () => { throw new Error("boom"); });

		const r = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 1000,
			payload: { message: "x" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(result.failed, 1);
		assert.equal(result.fired, 0);
		const obj = h.objects.get(r.id)!;
		assert.equal(obj.fields.status.stringValue, "failed");
		assert.match(obj.fields.last_error.stringValue, /boom/);
	});

	it("skips cancelled and already-sent reminders", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		h.onDispatch("/discord", "send", () => ({ channel_id: "c", message_ids: [] }));

		const cancelled = await schedule(h.ctx, {
			channel: "discord", target: "g", fire_at: Date.now() - 1000, payload: {},
		}) as { id: string };
		await cancel(h.ctx, cancelled.id);

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(result.fired, 0);
		assert.equal(h.objects.get(cancelled.id)!.fields.status.stringValue, "cancelled");
	});

	it("marks status=sending before dispatch (idempotency guard)", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		let observedStatusAtDispatch: string | undefined;
		h.onDispatch("/discord", "send", () => {
			// During dispatch, the reminder's on-disk status should be 'sending'.
			for (const obj of h.objects.values()) {
				if (obj.typeKey === "reminder") {
					observedStatusAtDispatch = obj.fields.status.stringValue;
				}
			}
			return { channel_id: "c", message_ids: ["m"] };
		});

		await schedule(h.ctx, {
			channel: "discord", target: "g",
			fire_at: Date.now() - 1000, payload: { message: "x" },
		});
		await __test.runSchedulerTick(h.ctx);
		assert.equal(observedStatusAtDispatch, "sending");
	});
});

// ── channel set ──────────────────────────────────────────────────

describe("CHANNELS", () => {
	it("exposes the supported channels", () => {
		assert.deepEqual([...CHANNELS].sort(), ["discord", "email", "gracie_compose"].sort());
	});
});
