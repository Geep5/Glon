/**
 * Peer program tests.
 *
 * Exercises the actor-level API: add, list (with filters), get, findOrCreate,
 * setTrust, setField, remove. Uses the same in-memory store harness pattern
 * as the agent tool-use tests.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import peerProgram from "../src/programs/handlers/peer.js";
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
				if (!obj) throw new Error(`no object ${id}`);
				obj.deleted = true;
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
				id,
				typeKey: o.typeKey,
				fields: o.fields,
				deleted: o.deleted,
				blocks: [],
				blockProvenance: {},
				content: "",
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: 0,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `peer-${nextId++}`;
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
		client,
		store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) if (k === prefix || k.startsWith(prefix)) return k;
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
		programId: "test-peer-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async () => undefined,
	};

	return { ctx, objects };
}

describe("peer program", () => {
	it("add creates a peer with the right fields", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;

		const id = await add(h.ctx, {
			display_name: "Grant",
			kind: "self",
			trust_level: "self",
			discord_id: "111",
			email: "grant@example.com",
		}) as string;

		const obj = h.objects.get(id)!;
		assert.equal(obj.typeKey, "peer");
		assert.equal(obj.fields.display_name.stringValue, "Grant");
		assert.equal(obj.fields.kind.stringValue, "self");
		assert.equal(obj.fields.trust_level.stringValue, "self");
		assert.equal(obj.fields.discord_id.stringValue, "111");
		assert.equal(obj.fields.email.stringValue, "grant@example.com");
	});

	it("add applies defaults when kind/trust omitted", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const id = await add(h.ctx, { display_name: "Anonymous" }) as string;
		const obj = h.objects.get(id)!;
		assert.equal(obj.fields.kind.stringValue, "human");
		assert.equal(obj.fields.trust_level.stringValue, "stranger");
	});

	it("list returns all peers, filtered by kind or trust", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const list = peerProgram.actor!.actions!.list;

		await add(h.ctx, { display_name: "Grant", kind: "self", trust_level: "self" });
		await add(h.ctx, { display_name: "Mom", kind: "human", trust_level: "family" });
		await add(h.ctx, { display_name: "FIG", kind: "agent", trust_level: "family" });
		await add(h.ctx, { display_name: "rando", kind: "human", trust_level: "stranger" });

		const all = await list(h.ctx) as Array<{ display_name: string }>;
		assert.equal(all.length, 4);

		const agents = await list(h.ctx, { kind: "agent" }) as Array<{ display_name: string }>;
		assert.equal(agents.length, 1);
		assert.equal(agents[0].display_name, "FIG");

		const family = await list(h.ctx, { trust_level: "family" }) as Array<{ display_name: string }>;
		assert.equal(family.length, 2);
		const familyNames = family.map((p) => p.display_name).sort();
		assert.deepEqual(familyNames, ["FIG", "Mom"]);
	});

	it("list skips tombstoned peers", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const remove = peerProgram.actor!.actions!.remove;
		const list = peerProgram.actor!.actions!.list;

		const id = await add(h.ctx, { display_name: "Drop", kind: "human" }) as string;
		await add(h.ctx, { display_name: "Keep", kind: "human" });
		await remove(h.ctx, id);

		const peers = await list(h.ctx) as Array<{ display_name: string }>;
		assert.equal(peers.length, 1);
		assert.equal(peers[0].display_name, "Keep");
	});

	it("get returns the record; returns null for unknown or wrong type", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const get = peerProgram.actor!.actions!.get;

		const id = await add(h.ctx, { display_name: "Mom", email: "mom@ex.com" }) as string;
		const rec = await get(h.ctx, id) as { display_name: string; email: string };
		assert.equal(rec.display_name, "Mom");
		assert.equal(rec.email, "mom@ex.com");

		assert.equal(await get(h.ctx, "nonexistent"), null);

		// wrong type
		h.objects.set("chat-obj", { id: "chat-obj", typeKey: "chat", fields: {}, deleted: false });
		assert.equal(await get(h.ctx, "chat-obj"), null);
	});

	it("findOrCreate creates when no match, finds when present", async () => {
		const h = createHarness();
		const findOrCreate = peerProgram.actor!.actions!.findOrCreate;

		const first = await findOrCreate(h.ctx, "discord_id", "999", {
			display_name: "NewPerson",
			kind: "human",
			trust_level: "stranger",
		}) as { id: string; created: boolean };
		assert.equal(first.created, true);
		assert.ok(first.id);

		const second = await findOrCreate(h.ctx, "discord_id", "999", {
			display_name: "DifferentName",
		}) as { id: string; created: boolean };
		assert.equal(second.created, false);
		assert.equal(second.id, first.id);
		// First peer's display_name unchanged
		const obj = h.objects.get(first.id)!;
		assert.equal(obj.fields.display_name.stringValue, "NewPerson");
	});

	it("findOrCreate rejects unknown external keys", async () => {
		const h = createHarness();
		const findOrCreate = peerProgram.actor!.actions!.findOrCreate;
		await assert.rejects(
			() => findOrCreate(h.ctx, "slack_id", "abc", {}),
			/unknown external key/,
		);
	});

	it("setTrust updates trust_level", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const setTrust = peerProgram.actor!.actions!.setTrust;
		const get = peerProgram.actor!.actions!.get;

		const id = await add(h.ctx, { display_name: "Maybe", trust_level: "stranger" }) as string;
		await setTrust(h.ctx, id, "family");
		const rec = await get(h.ctx, id) as { trust_level: string };
		assert.equal(rec.trust_level, "family");
	});

	it("setField updates arbitrary recognized fields and rejects unknown", async () => {
		const h = createHarness();
		const add = peerProgram.actor!.actions!.add;
		const setField = peerProgram.actor!.actions!.setField;
		const get = peerProgram.actor!.actions!.get;

		const id = await add(h.ctx, { display_name: "X" }) as string;
		await setField(h.ctx, id, "notes", "prefers email to Discord");
		const rec = await get(h.ctx, id) as { notes: string };
		assert.equal(rec.notes, "prefers email to Discord");

		await assert.rejects(
			() => setField(h.ctx, id, "pager", "555"),
			/unknown field/,
		);
	});
});
