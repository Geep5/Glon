/**
 * Tests for the read + write introspection actors on /crud, /inspect, /graph.
 *
 * Every action is a thin wrapper over store / objectActor / change-file
 * primitives. These tests exercise the wrapper semantics: shape of the
 * output, argument coercion (positional or object input), truncation,
 * and the error paths.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import crudProgram from "../src/programs/handlers/crud.js";
import inspectProgram from "../src/programs/handlers/inspect.js";
import graphProgram from "../src/programs/handlers/graph.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Harness ──────────────────────────────────────────────────────

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	contentB64: string;
	blocks: any[];
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredObj>();
	const changes: Array<{ hex: string; objectId: string; parentIds: Uint8Array[]; ops: any[]; timestamp: number; author: string; id: Uint8Array }> = [];
	const links = new Map<string, Array<{ relationKey: string; targetId: string }>>(); // source_id → outbound
	let nextId = 1;
	let nextHex = 1;
	let nextTs = 1000;

	function actorFor(id: string) {
		return {
			read: async () => {
				const o = objects.get(id);
				if (!o) return null;
				return {
					id: o.id, typeKey: o.typeKey, fields: o.fields, content: o.contentB64,
					blocks: o.blocks, blockProvenance: {}, deleted: o.deleted,
					createdAt: 0, updatedAt: 0, headIds: ["head-" + id], changeCount: 1,
				};
			},
			readContent: async () => {
				const o = objects.get(id);
				if (!o || !o.contentB64) return "";
				return Buffer.from(o.contentB64, "base64").toString("utf-8");
			},
			setField: async (key: string, valueJson: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				const value = JSON.parse(valueJson);
				o.fields[key] = value;
				changes.push({
					hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
					author: "test", id: new Uint8Array(0),
					ops: [{ fieldSet: { key, value } }],
				});
			},
			setFields: async (json: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				const fields = JSON.parse(json);
				for (const [k, v] of Object.entries(fields)) o.fields[k] = v;
				changes.push({
					hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
					author: "test", id: new Uint8Array(0),
					ops: Object.entries(fields).map(([k, v]) => ({ fieldSet: { key: k, value: v } })),
				});
			},
			setContent: async (b64: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				o.contentB64 = b64;
				changes.push({
					hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
					author: "test", id: new Uint8Array(0),
					ops: [{ contentSet: { content: Buffer.from(b64, "base64") } }],
				});
			},
			deleteField: async (key: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				delete o.fields[key];
				changes.push({
					hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
					author: "test", id: new Uint8Array(0),
					ops: [{ fieldDelete: { key } }],
				});
			},
			markDeleted: async () => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				o.deleted = true;
			},
			addBlock: async (json: string) => {
				const o = objects.get(id);
				if (!o) throw new Error(`no object ${id}`);
				const block = JSON.parse(json);
				o.blocks.push(block);
				changes.push({
					hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
					author: "test", id: new Uint8Array(0),
					ops: [{ blockAdd: { block } }],
				});
			},
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id);
			if (!o) return null;
			return {
				id: o.id, typeKey: o.typeKey, fields: o.fields, content: o.contentB64,
				blocks: o.blocks, blockProvenance: {}, deleted: o.deleted,
				createdAt: 0, updatedAt: 0, headIds: ["head-" + id], changeCount: 1,
			};
		},
		create: async (typeKey: string, fieldsJson?: string, contentB64?: string) => {
			const id = `${typeKey}-${nextId++}`;
			objects.set(id, {
				id, typeKey,
				fields: fieldsJson ? JSON.parse(fieldsJson) : {},
				contentB64: contentB64 ?? "",
				blocks: [],
				deleted: false,
			});
			return id;
		},
		list: async (typeKey?: string) => {
			const refs: { id: string; typeKey: string; createdAt: number; updatedAt: number }[] = [];
			for (const o of objects.values()) {
				if (typeKey && o.typeKey !== typeKey) continue;
				refs.push({ id: o.id, typeKey: o.typeKey, createdAt: 0, updatedAt: 0 });
			}
			return refs;
		},
		search: async (query: string) => {
			const refs: { id: string; typeKey: string; createdAt: number; updatedAt: number }[] = [];
			for (const o of objects.values()) {
				const blob = JSON.stringify(o.fields) + " " + Buffer.from(o.contentB64, "base64").toString("utf-8");
				if (blob.toLowerCase().includes(query.toLowerCase())) {
					refs.push({ id: o.id, typeKey: o.typeKey, createdAt: 0, updatedAt: 0 });
				}
			}
			return refs;
		},
		getLinks: async (id: string) => links.get(id) ?? [],
		getBacklinks: async (id: string) => {
			const inbound: Array<{ relationKey: string; sourceId: string }> = [];
			for (const [src, outs] of links) {
				for (const l of outs) {
					if (l.targetId === id) inbound.push({ relationKey: l.relationKey, sourceId: src });
				}
			}
			return inbound;
		},
		neighbors: async (id: string) => {
			const outbound = (links.get(id) ?? []).map((l) => ({
				id: l.targetId,
				typeKey: objects.get(l.targetId)?.typeKey ?? "unknown",
				relationKey: l.relationKey,
			}));
			const inbound: any[] = [];
			for (const [src, outs] of links) {
				for (const l of outs) {
					if (l.targetId === id) inbound.push({
						id: src,
						typeKey: objects.get(src)?.typeKey ?? "unknown",
						relationKey: l.relationKey,
					});
				}
			}
			return { outbound, inbound };
		},
		graphQuery: async (id: string, depth: number) => {
			const out: Array<{ id: string; typeKey: string; depth: number; links: any[] }> = [];
			const visited = new Set<string>();
			function walk(cur: string, d: number) {
				if (visited.has(cur) || d > depth) return;
				visited.add(cur);
				const o = objects.get(cur);
				if (!o) return;
				const ls = links.get(cur) ?? [];
				out.push({ id: cur, typeKey: o.typeKey, depth: d, links: ls });
				for (const l of ls) walk(l.targetId, d + 1);
			}
			walk(id, 0);
			return out;
		},
	};

	const client = {
		objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) },
	};

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => (objects.has(p) ? p : null),
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => changes.map((c) => c.hex),
		readChangeByHex: (hex: string) => {
			const c = changes.find((x) => x.hex === hex);
			if (!c) return null;
			return {
				id: Buffer.from(hex, "utf-8") as unknown as Uint8Array,
				objectId: c.objectId,
				parentIds: c.parentIds,
				ops: c.ops,
				timestamp: c.timestamp,
				author: c.author,
			} as any;
		},
		hexEncode: (b: Uint8Array) => Buffer.from(b).toString("utf-8"),
		print: () => {},
		randomUUID: () => `uuid-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async () => undefined,
	};

	return {
		ctx, objects, changes, links,
		seedObject(typeKey: string, fields: Record<string, any> = {}, content = "") {
			const id = `${typeKey}-${nextId++}`;
			objects.set(id, {
				id, typeKey, fields,
				contentB64: Buffer.from(content, "utf-8").toString("base64"),
				blocks: [],
				deleted: false,
			});
			// record a genesis change
			changes.push({
				hex: `ch${nextHex++}`, objectId: id, parentIds: [], timestamp: nextTs++,
				author: "seed", id: new Uint8Array(0),
				ops: [{ objectCreate: { typeKey } }],
			});
			return id;
		},
		addLink(src: string, targetId: string, relationKey: string) {
			const arr = links.get(src) ?? [];
			arr.push({ relationKey, targetId });
			links.set(src, arr);
		},
	};
}

// ── /crud actions ─────────────────────────────────────────────────

describe("/crud actor — read", () => {
	it("list returns refs filtered by type_key", async () => {
		const h = createHarness();
		h.seedObject("peer", { display_name: stringVal("Grant") });
		h.seedObject("peer", { display_name: stringVal("Mom") });
		h.seedObject("program", { prefix: stringVal("/remind") });
		const list = crudProgram.actor!.actions!.list;
		const all = await list(h.ctx) as { objects: any[]; total: number };
		assert.equal(all.total, 3);
		const peers = await list(h.ctx, { type_key: "peer" }) as { objects: any[]; total: number };
		assert.equal(peers.total, 2);
		assert.equal(peers.objects.every((o) => o.typeKey === "peer"), true);
	});

	it("get returns a summary; null for missing", async () => {
		const h = createHarness();
		const id = h.seedObject("note", { body: stringVal("hello world") }, "abcdef");
		const get = crudProgram.actor!.actions!.get;
		const res = await get(h.ctx, { object_id: id }) as any;
		assert.equal(res.id, id);
		assert.equal(res.typeKey, "note");
		assert.equal(res.contentBytes, 6);
		assert.equal(res.deleted, false);
		assert.equal(await get(h.ctx, { object_id: "nope" }), null);
	});

	it("readContent truncates beyond max_bytes", async () => {
		const h = createHarness();
		const big = "x".repeat(25_000);
		const id = h.seedObject("file", {}, big);
		const readContent = crudProgram.actor!.actions!.readContent;
		const short = await readContent(h.ctx, { object_id: id, max_bytes: 16384 }) as any;
		assert.equal(short.truncated, true);
		assert.equal(short.full_bytes, 25_000);
		assert.ok(short.content.includes("[truncated"));
		const full = await readContent(h.ctx, { object_id: id, max_bytes: 65536 }) as any;
		assert.equal(full.truncated, false);
		assert.equal(full.content.length, 25_000);
	});

	it("search finds matches across fields and content", async () => {
		const h = createHarness();
		h.seedObject("peer", { display_name: stringVal("Grant") });
		h.seedObject("peer", { display_name: stringVal("Graice"), notes: stringVal("the assistant") });
		h.seedObject("program", { prefix: stringVal("/discord") });
		const search = crudProgram.actor!.actions!.search;
		const matches = await search(h.ctx, { query: "Graice" }) as { matches: any[] };
		assert.equal(matches.matches.length, 1);
		const filtered = await search(h.ctx, { query: "discord", type_key: "peer" }) as { matches: any[] };
		assert.equal(filtered.matches.length, 0);
	});
});

describe("/crud actor — write", () => {
	it("create with primitive field coercion", async () => {
		const h = createHarness();
		const create = crudProgram.actor!.actions!.create;
		const res = await create(h.ctx, {
			type_key: "task",
			fields: { title: "call Mom", priority: 2, urgent: false },
		}) as { id: string };
		const obj = h.objects.get(res.id)!;
		assert.equal(obj.fields.title.stringValue, "call Mom");
		assert.equal(obj.fields.priority.intValue, 2);
		assert.equal(obj.fields.urgent.boolValue, false);
	});

	it("create with utf-8 content", async () => {
		const h = createHarness();
		const create = crudProgram.actor!.actions!.create;
		const res = await create(h.ctx, {
			type_key: "markdown",
			fields: {},
			content: "# Hello\nbody",
		}) as { id: string };
		assert.equal(Buffer.from(h.objects.get(res.id)!.contentB64, "base64").toString("utf-8"), "# Hello\nbody");
	});

	it("setField coerces primitives", async () => {
		const h = createHarness();
		const id = h.seedObject("agent", {});
		const setField = crudProgram.actor!.actions!.setField;
		await setField(h.ctx, { object_id: id, key: "model", value: "claude-sonnet-4" });
		await setField(h.ctx, { object_id: id, key: "temperature", value: 0.5 });
		await setField(h.ctx, { object_id: id, key: "active", value: true });
		const obj = h.objects.get(id)!;
		assert.equal(obj.fields.model.stringValue, "claude-sonnet-4");
		assert.equal(obj.fields.temperature.floatValue, 0.5);
		assert.equal(obj.fields.active.boolValue, true);
	});

	it("setField accepts a pre-built Value object", async () => {
		const h = createHarness();
		const id = h.seedObject("agent", {});
		const setField = crudProgram.actor!.actions!.setField;
		await setField(h.ctx, {
			object_id: id, key: "tools",
			value: mapVal({ foo: stringVal("bar") }),
		});
		const obj = h.objects.get(id)!;
		assert.ok(obj.fields.tools.mapValue.entries.foo);
		assert.equal(obj.fields.tools.mapValue.entries.foo.stringValue, "bar");
	});

	it("setContent + setFields + deleteField round-trip", async () => {
		const h = createHarness();
		const id = h.seedObject("file", { title: stringVal("old") }, "old bytes");
		const setContent = crudProgram.actor!.actions!.setContent;
		const setFields = crudProgram.actor!.actions!.setFields;
		const deleteField = crudProgram.actor!.actions!.deleteField;

		await setContent(h.ctx, { object_id: id, content: "new bytes" });
		assert.equal(Buffer.from(h.objects.get(id)!.contentB64, "base64").toString("utf-8"), "new bytes");

		await setFields(h.ctx, { object_id: id, fields: { title: "new", kind: "essay" } });
		assert.equal(h.objects.get(id)!.fields.title.stringValue, "new");
		assert.equal(h.objects.get(id)!.fields.kind.stringValue, "essay");

		await deleteField(h.ctx, { object_id: id, key: "kind" });
		assert.equal(h.objects.get(id)!.fields.kind, undefined);
	});

	it("remove tombstones without hard-deleting", async () => {
		const h = createHarness();
		const id = h.seedObject("peer", { display_name: stringVal("X") });
		const remove = crudProgram.actor!.actions!.remove;
		await remove(h.ctx, { object_id: id });
		assert.equal(h.objects.get(id)!.deleted, true);
		assert.ok(h.objects.has(id), "object still exists (tombstone only)");
	});

	it("addBlock appends a block", async () => {
		const h = createHarness();
		const id = h.seedObject("agent", {});
		const addBlock = crudProgram.actor!.actions!.addBlock;
		await addBlock(h.ctx, {
			object_id: id,
			block: { id: "b1", childrenIds: [], content: { text: { text: "hi", style: 0 } } },
		});
		assert.equal(h.objects.get(id)!.blocks.length, 1);
		assert.equal(h.objects.get(id)!.blocks[0].content.text.text, "hi");
	});

	it("setField rejects missing object_id / key", async () => {
		const h = createHarness();
		const setField = crudProgram.actor!.actions!.setField;
		await assert.rejects(() => setField(h.ctx, { key: "x", value: "y" } as any), /object_id/);
		await assert.rejects(() => setField(h.ctx, { object_id: "x", value: "y" } as any), /key/);
	});
});

// ── /inspect actions ──────────────────────────────────────────────

describe("/inspect actor", () => {
	it("history returns sorted changes with op summaries", async () => {
		const h = createHarness();
		const id = h.seedObject("peer", { display_name: stringVal("Grant") });
		const actor = h.ctx.objectActor(id) as any;
		await actor.setField("kind", JSON.stringify(stringVal("self")));
		await actor.setField("trust_level", JSON.stringify(stringVal("self")));
		const history = inspectProgram.actor!.actions!.history;
		const res = await history(h.ctx, { object_id: id }) as { total: number; changes: any[] };
		assert.equal(res.total, 3);
		assert.equal(res.changes.length, 3);
		assert.match(res.changes[0].op_summary, /create/);
		assert.match(res.changes[1].op_summary, /set\(kind\)/);
	});

	it("heads returns the object's current heads", async () => {
		const h = createHarness();
		const id = h.seedObject("peer");
		const heads = inspectProgram.actor!.actions!.heads;
		const res = await heads(h.ctx, { object_id: id }) as { head_ids: string[] };
		assert.equal(res.head_ids.length, 1);
		assert.equal(res.head_ids[0], "head-" + id);
	});

	it("changeDetail returns structured ops for a given hex", async () => {
		const h = createHarness();
		const id = h.seedObject("peer");
		const actor = h.ctx.objectActor(id) as any;
		await actor.setField("notes", JSON.stringify(stringVal("hello")));
		const hex = h.changes[h.changes.length - 1].hex;
		const changeDetail = inspectProgram.actor!.actions!.changeDetail;
		const res = await changeDetail(h.ctx, { hex_id: hex }) as any;
		assert.ok(res);
		assert.equal(res.object_id, id);
		assert.equal(res.ops[0].type, "fieldSet");
		assert.equal(res.ops[0].key, "notes");
	});

	it("changeDetail returns null for unknown hex", async () => {
		const h = createHarness();
		const changeDetail = inspectProgram.actor!.actions!.changeDetail;
		assert.equal(await changeDetail(h.ctx, { hex_id: "nope" }), null);
	});
});

// ── /graph actions ────────────────────────────────────────────────

describe("/graph actor", () => {
	it("links returns outbound and inbound relation keys", async () => {
		const h = createHarness();
		const a = h.seedObject("agent");
		const b = h.seedObject("peer");
		h.addLink(a, b, "principal");
		const links = graphProgram.actor!.actions!.links;
		const res = await links(h.ctx, { object_id: a }) as { outbound: any[]; inbound: any[] };
		assert.equal(res.outbound.length, 1);
		assert.equal(res.outbound[0].relation_key, "principal");
		assert.equal(res.outbound[0].target_id, b);
		const res2 = await links(h.ctx, { object_id: b }) as { outbound: any[]; inbound: any[] };
		assert.equal(res2.inbound.length, 1);
		assert.equal(res2.inbound[0].source_id, a);
	});

	it("neighbors includes outbound + inbound with typeKey", async () => {
		const h = createHarness();
		const a = h.seedObject("agent");
		const b = h.seedObject("peer");
		h.addLink(a, b, "principal");
		const neighbors = graphProgram.actor!.actions!.neighbors;
		const res = await neighbors(h.ctx, { object_id: b }) as { outbound: any[]; inbound: any[] };
		assert.equal(res.inbound.length, 1);
		assert.equal(res.inbound[0].type_key, "agent");
	});

	it("traverse walks the graph up to max_depth", async () => {
		const h = createHarness();
		const a = h.seedObject("agent");
		const b = h.seedObject("peer");
		const c = h.seedObject("peer");
		h.addLink(a, b, "to_b");
		h.addLink(b, c, "to_c");
		const traverse = graphProgram.actor!.actions!.traverse;
		const res = await traverse(h.ctx, { object_id: a, max_depth: 2 }) as { nodes: any[] };
		assert.equal(res.nodes.length, 3);
		assert.equal(res.nodes[0].depth, 0);
		assert.equal(res.nodes[res.nodes.length - 1].id, c);
	});

	it("traverse caps max_depth at 5", async () => {
		const h = createHarness();
		const a = h.seedObject("peer");
		const traverse = graphProgram.actor!.actions!.traverse;
		// Ask for 100 — should silently cap at 5 without throwing.
		const res = await traverse(h.ctx, { object_id: a, max_depth: 100 }) as { nodes: any[] };
		assert.equal(res.nodes[0].id, a);
	});
});
