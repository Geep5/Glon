/**
 * /todo program tests.
 *
 * Covers:
 *   - applyOps: replace/add_phase/add_task/update/remove_task with status normalization
 *   - normalization: exactly-one in_progress; auto-promote first pending
 *   - summarizeIncomplete: filters to pending/in_progress only
 *   - actor.write/get/incomplete/clear: full round-trip through the in-memory store
 *   - validator: rejects malformed create batches
 *   - todoWriteToolSpec: bound owner shape
 *
 * Mocks store/actor with a minimal in-memory harness — same pattern as
 * test/agent-tooluse.test.ts.
 *
 * Run: npx tsx --test test/todo.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import todoProgram, { __test, validator, todoWriteToolSpec, type TodoOp, type TodoPhase } from "../src/programs/handlers/todo.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const { applyOps, summarizeIncomplete, emptyState, TYPE_KEY } = __test;

// ── In-memory store harness ──────────────────────────────────────

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	deleted?: boolean;
}

function createTestHarness() {
	const objects = new Map<string, StoredObj>();
	let counter = 0;

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.setField: no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.markDeleted: no object ${id}`);
				obj.deleted = true;
			},
		};
	}

	const store = {
		get: async (id: string) => {
			const obj = objects.get(id);
			if (!obj) return null;
			return {
				id,
				typeKey: obj.typeKey,
				fields: obj.fields,
				deleted: obj.deleted ?? false,
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
			const id = `obj-${++counter}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {} });
			return id;
		},
		list: async (typeKey?: string) => {
			const out: { id: string; typeKey: string }[] = [];
			for (const [id, obj] of objects) {
				if (obj.deleted) continue;
				if (typeKey && obj.typeKey !== typeKey) continue;
				out.push({ id, typeKey: obj.typeKey });
			}
			return out;
		},
	};

	const client = {
		objectActor: {
			getOrCreate: (args: string[]) => actorFor(args[0]),
		},
	};

	const ctx: ProgramContext = {
		client,
		store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) {
				if (k === prefix || k.startsWith(prefix)) return k;
			}
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: (() => {
			let n = 0;
			return () => `uuid-${++n}`;
		})(),
		state: {},
		emit: () => {},
		programId: "test-todo-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async () => { throw new Error("no dispatch handlers in todo tests"); },
	};

	return { ctx, objects };
}

function getActions() {
	const actions = todoProgram.actor?.actions;
	if (!actions) throw new Error("todo program is missing actor.actions");
	return actions;
}

// ── Pure ops tests ───────────────────────────────────────────────

describe("applyOps", () => {
	it("replace creates phases and tasks with sequential ids", () => {
		const start = emptyState();
		const ops: TodoOp[] = [{
			op: "replace",
			phases: [
				{ name: "Foundation", tasks: [{ content: "Scaffold" }, { content: "Wire" }] },
				{ name: "Auth", tasks: [{ content: "Port creds" }] },
			],
		}];
		const { state, errors } = applyOps(start, ops);
		assert.deepEqual(errors, []);
		assert.equal(state.phases.length, 2);
		assert.equal(state.phases[0].id, "phase-1");
		assert.equal(state.phases[1].id, "phase-2");
		assert.deepEqual(state.phases[0].tasks.map((t) => t.id), ["task-1", "task-2"]);
		assert.deepEqual(state.phases[1].tasks.map((t) => t.id), ["task-3"]);
	});

	it("auto-promotes the first pending task to in_progress when none are running", () => {
		const start = emptyState();
		const ops: TodoOp[] = [{
			op: "replace",
			phases: [{ name: "Phase", tasks: [{ content: "First" }, { content: "Second" }] }],
		}];
		const { state } = applyOps(start, ops);
		assert.equal(state.phases[0].tasks[0].status, "in_progress");
		assert.equal(state.phases[0].tasks[1].status, "pending");
	});

	it("demotes extra in_progress tasks to pending", () => {
		const start = emptyState();
		const seed: TodoOp[] = [{
			op: "replace",
			phases: [{ name: "Phase", tasks: [{ content: "A" }, { content: "B" }, { content: "C" }] }],
		}];
		const seeded = applyOps(start, seed).state;
		// Force two in_progress.
		const { state } = applyOps(seeded, [
			{ op: "update", id: "task-2", status: "in_progress" },
		]);
		const inProgress = state.phases.flatMap((p) => p.tasks).filter((t) => t.status === "in_progress");
		assert.equal(inProgress.length, 1, "exactly one in_progress allowed");
	});

	it("update changes status, content, notes", () => {
		const start = applyOps(emptyState(), [{
			op: "replace",
			phases: [{ name: "P", tasks: [{ content: "Original" }] }],
		}]).state;
		const { state, errors } = applyOps(start, [
			{ op: "update", id: "task-1", status: "completed", content: "Updated", notes: "fyi" },
		]);
		assert.deepEqual(errors, []);
		const t = state.phases[0].tasks[0];
		assert.equal(t.status, "completed");
		assert.equal(t.content, "Updated");
		assert.equal(t.notes, "fyi");
	});

	it("update on completion auto-promotes next pending", () => {
		const start = applyOps(emptyState(), [{
			op: "replace",
			phases: [{ name: "P", tasks: [{ content: "One" }, { content: "Two" }] }],
		}]).state;
		// task-1 starts as in_progress (auto-promoted). Mark it done.
		const { state } = applyOps(start, [{ op: "update", id: "task-1", status: "completed" }]);
		assert.equal(state.phases[0].tasks[0].status, "completed");
		assert.equal(state.phases[0].tasks[1].status, "in_progress");
	});

	it("add_task appends to the named phase", () => {
		const start = applyOps(emptyState(), [{
			op: "replace",
			phases: [{ name: "P", tasks: [{ content: "First" }] }],
		}]).state;
		const { state, errors } = applyOps(start, [
			{ op: "add_task", phase: "phase-1", content: "Second" },
		]);
		assert.deepEqual(errors, []);
		assert.equal(state.phases[0].tasks.length, 2);
		assert.equal(state.phases[0].tasks[1].id, "task-2");
	});

	it("remove_task drops the matching task", () => {
		const start = applyOps(emptyState(), [{
			op: "replace",
			phases: [{ name: "P", tasks: [{ content: "A" }, { content: "B" }] }],
		}]).state;
		const { state } = applyOps(start, [{ op: "remove_task", id: "task-1" }]);
		assert.equal(state.phases[0].tasks.length, 1);
		assert.equal(state.phases[0].tasks[0].id, "task-2");
		// task-2 should now be auto-promoted since task-1 was the in_progress one.
		assert.equal(state.phases[0].tasks[0].status, "in_progress");
	});

	it("reports an error when add_task references a missing phase", () => {
		const { errors } = applyOps(emptyState(), [
			{ op: "add_task", phase: "phase-99", content: "Orphan" },
		]);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /phase-99/);
	});

	it("reports errors for unknown task ids", () => {
		const { errors } = applyOps(emptyState(), [
			{ op: "update", id: "task-99" },
			{ op: "remove_task", id: "task-77" },
		]);
		assert.equal(errors.length, 2);
	});
});

describe("summarizeIncomplete", () => {
	it("includes only pending and in_progress tasks", () => {
		const state = applyOps(emptyState(), [{
			op: "replace",
			phases: [
				{ name: "Done phase", tasks: [{ content: "Old", status: "completed" }] },
				{ name: "Live phase", tasks: [{ content: "Now" }, { content: "Next" }] },
			],
		}]).state;
		const summary = summarizeIncomplete(state);
		assert.equal(summary.total, 2);
		assert.equal(summary.phases.length, 1);
		assert.equal(summary.phases[0].name, "Live phase");
	});

	it("returns total=0 when everything is completed", () => {
		const state = applyOps(emptyState(), [{
			op: "replace",
			phases: [{ name: "P", tasks: [{ content: "x", status: "completed" }] }],
		}]).state;
		const summary = summarizeIncomplete(state);
		assert.equal(summary.total, 0);
		assert.equal(summary.phases.length, 0);
	});
});

// ── Actor action round-trips ─────────────────────────────────────

describe("actor.actions", () => {
	it("write creates the agent_todos object on first call and persists state", async () => {
		const { ctx, objects } = createTestHarness();
		const actions = getActions();

		const r1 = await actions.write(ctx, {
			owner: "agent-1",
			ops: [{ op: "replace", phases: [{ name: "P1", tasks: [{ content: "A" }, { content: "B" }] }] }],
		}) as { id: string; phases: TodoPhase[]; errors: string[] };

		assert.ok(r1.id);
		assert.equal(r1.phases.length, 1);
		assert.equal(r1.phases[0].tasks.length, 2);

		const obj = objects.get(r1.id);
		assert.ok(obj);
		assert.equal(obj.typeKey, TYPE_KEY);
		assert.equal(obj.fields.owner.linkValue.targetId, "agent-1");
		const stored = JSON.parse(obj.fields.phases_json.stringValue);
		assert.equal(stored.phases.length, 1);
	});

	it("subsequent writes find and update the existing object", async () => {
		const { ctx, objects } = createTestHarness();
		const actions = getActions();

		const r1 = await actions.write(ctx, {
			owner: "agent-1",
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "A" }] }] }],
		}) as { id: string };

		const r2 = await actions.write(ctx, {
			owner: "agent-1",
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		}) as { id: string; phases: TodoPhase[] };

		assert.equal(r1.id, r2.id);
		assert.equal(objects.size, 1);
		assert.equal(r2.phases[0].tasks[0].status, "completed");
	});

	it("scopes writes by owner — different agents get independent lists", async () => {
		const { ctx, objects } = createTestHarness();
		const actions = getActions();

		await actions.write(ctx, { owner: "agent-1", ops: [{ op: "replace", phases: [{ name: "A", tasks: [{ content: "x" }] }] }] });
		await actions.write(ctx, { owner: "agent-2", ops: [{ op: "replace", phases: [{ name: "B", tasks: [{ content: "y" }] }] }] });

		assert.equal(objects.size, 2);

		const a = await actions.get(ctx, "agent-1") as { phases: TodoPhase[] };
		const b = await actions.get(ctx, "agent-2") as { phases: TodoPhase[] };
		assert.equal(a.phases[0].name, "A");
		assert.equal(b.phases[0].name, "B");
	});

	it("incomplete returns empty when there are no todos", async () => {
		const { ctx } = createTestHarness();
		const actions = getActions();
		const r = await actions.incomplete(ctx, "ghost-agent") as { phases: unknown[]; total: number };
		assert.deepEqual(r, { phases: [], total: 0 });
	});

	it("incomplete returns pending/in_progress only", async () => {
		const { ctx } = createTestHarness();
		const actions = getActions();
		await actions.write(ctx, {
			owner: "agent-1",
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "x" }, { content: "y" }, { content: "z" }] }] }],
		});
		// Complete one.
		await actions.write(ctx, { owner: "agent-1", ops: [{ op: "update", id: "task-1", status: "completed" }] });

		const r = await actions.incomplete(ctx, "agent-1") as { phases: { tasks: { id: string }[] }[]; total: number };
		assert.equal(r.total, 2);
		const ids = r.phases.flatMap((p) => p.tasks.map((t) => t.id));
		assert.deepEqual(ids.sort(), ["task-2", "task-3"]);
	});

	it("clear resets the list to empty without tombstoning the object", async () => {
		const { ctx, objects } = createTestHarness();
		const actions = getActions();
		const r1 = await actions.write(ctx, {
			owner: "agent-1",
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "x" }] }] }],
		}) as { id: string };

		const cleared = await actions.clear(ctx, "agent-1") as { ok: boolean };
		assert.equal(cleared.ok, true);

		const obj = objects.get(r1.id);
		assert.ok(obj);
		assert.equal(obj.deleted ?? false, false, "clear should preserve the object");
		const stored = JSON.parse(obj.fields.phases_json.stringValue);
		assert.deepEqual(stored.phases, []);

		const r = await actions.get(ctx, "agent-1") as { phases: TodoPhase[] };
		assert.deepEqual(r.phases, []);
	});

	it("clear reports false when nothing exists for the agent", async () => {
		const { ctx } = createTestHarness();
		const actions = getActions();
		const r = await actions.clear(ctx, "nobody") as { ok: boolean };
		assert.equal(r.ok, false);
	});

	it("rejects writes without an owner", async () => {
		const { ctx } = createTestHarness();
		const actions = getActions();
		await assert.rejects(() => actions.write(ctx, { ops: [] } as any), /owner/);
		await assert.rejects(() => actions.get(ctx, "" as any), /owner/);
	});
});

// ── Validator ────────────────────────────────────────────────────

describe("validator", () => {
	it("accepts a valid create batch", () => {
		const r = validator([{
			id: new Uint8Array(),
			objectId: "obj-1",
			parentIds: [],
			ops: [
				{ objectCreate: { typeKey: TYPE_KEY } },
				{ fieldSet: { key: "owner", value: { linkValue: { targetId: "agent-1", relationKey: "owner" } } } },
				{ fieldSet: { key: "phases_json", value: { stringValue: "{\"phases\":[]}" } } },
			],
			timestamp: 0,
			author: "test",
		} as any]);
		assert.equal(r.valid, true);
	});

	it("rejects a create batch missing owner", () => {
		const r = validator([{
			id: new Uint8Array(),
			objectId: "obj-1",
			parentIds: [],
			ops: [
				{ objectCreate: { typeKey: TYPE_KEY } },
				{ fieldSet: { key: "phases_json", value: { stringValue: "{}" } } },
			],
			timestamp: 0,
			author: "test",
		} as any]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /owner/);
	});

	it("rejects a create batch missing phases_json", () => {
		const r = validator([{
			id: new Uint8Array(),
			objectId: "obj-1",
			parentIds: [],
			ops: [
				{ objectCreate: { typeKey: TYPE_KEY } },
				{ fieldSet: { key: "owner", value: { linkValue: { targetId: "agent-1", relationKey: "owner" } } } },
			],
			timestamp: 0,
			author: "test",
		} as any]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /phases_json/);
	});

	it("rejects amendments that set phases_json to a non-string", () => {
		const r = validator([{
			id: new Uint8Array(),
			objectId: "obj-1",
			parentIds: [],
			ops: [
				{ fieldSet: { key: "phases_json", value: { intValue: 42 } } },
			],
			timestamp: 0,
			author: "test",
		} as any]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /phases_json/);
	});

	it("ignores non-todo objects in mixed batches", () => {
		const r = validator([{
			id: new Uint8Array(),
			objectId: "obj-other",
			parentIds: [],
			ops: [
				{ objectCreate: { typeKey: "something_else" } },
				{ fieldSet: { key: "anything", value: { stringValue: "ok" } } },
			],
			timestamp: 0,
			author: "test",
		} as any]);
		assert.equal(r.valid, true);
	});
});

// ── Tool spec shape ──────────────────────────────────────────────

describe("todoWriteToolSpec", () => {
	it("returns a spec with bound owner", () => {
		const spec = todoWriteToolSpec("agent-xyz");
		assert.equal(spec.name, "todo_write");
		assert.equal(spec.target_prefix, "/todo");
		assert.equal(spec.target_action, "write");
		assert.deepEqual(spec.bound_args, { owner: "agent-xyz" });
		assert.equal(spec.input_schema.type, "object");
	});
});
