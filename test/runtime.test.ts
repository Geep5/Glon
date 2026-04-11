/**
 * Program runtime tests — module bundling, actor lifecycle, validators.
 *
 * Run: npx tsx --test test/runtime.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	startProgramActor,
	stopProgramActor,
	dispatchActorAction,
	getProgramActor,
	getValidator,
	type ProgramContext,
	type ProgramEntry,
	type ProgramDef,
	type ValidationResult,
} from "../src/programs/runtime.js";
import { stringVal, intVal, boolVal } from "../src/proto.js";
import type { Change } from "../src/proto.js";

// ── Helpers ──────────────────────────────────────────────────────

function dummyCtx(overrides: Partial<ProgramContext> = {}): ProgramContext {
	return {
		client: {},
		store: {},
		resolveId: async () => null,
		stringVal, intVal,
		floatVal: (n: number) => ({ floatValue: n }),
		boolVal,
		mapVal: () => ({ mapValue: { entries: {} } }),
		listVal: () => ({ listValue: { values: [] } }),
		displayValue: () => "",
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => "test-uuid",
		state: {},
		emit: () => {},
		programId: "test-program",
		objectActor: () => ({}),
		...overrides,
	};
}

function makeEntry(id: string, prefix: string, def: ProgramDef): ProgramEntry {
	return {
		id,
		prefix,
		name: prefix,
		commands: {},
		handler: async () => {},
		def,
	};
}

// ── Tests ────────────────────────────────────────────────────────

describe("ProgramActor lifecycle", () => {
	it("start creates instance and stop cleans it up", async () => {
		const entry = makeEntry("prog-1", "/test", {
			actor: {
				createState: () => ({ counter: 0 }),
				actions: {
					inc: (ctx) => { ctx.state.counter++; return ctx.state.counter; },
					get: (ctx) => ctx.state.counter,
				},
			},
		});

		const instance = await startProgramActor(entry, (state) => dummyCtx({ state, programId: "prog-1" }));
		assert.ok(instance, "instance should be created");
		assert.equal(instance!.state.counter, 0);

		// Dispatch action
		const result = await dispatchActorAction(
			"prog-1", "inc", [],
			(state) => dummyCtx({ state, programId: "prog-1" }),
		);
		assert.equal(result, 1);

		// State persists
		const result2 = await dispatchActorAction(
			"prog-1", "get", [],
			(state) => dummyCtx({ state, programId: "prog-1" }),
		);
		assert.equal(result2, 1);

		// Stop
		await stopProgramActor("prog-1", (state) => dummyCtx({ state, programId: "prog-1" }));
		assert.equal(getProgramActor("prog-1"), undefined);
	});

	it("onCreate and onDestroy are called", async () => {
		const events: string[] = [];

		const entry = makeEntry("prog-2", "/lifecycle", {
			actor: {
				createState: () => ({}),
				onCreate: async () => { events.push("created"); },
				onDestroy: async () => { events.push("destroyed"); },
				actions: {},
			},
		});

		await startProgramActor(entry, (state) => dummyCtx({ state, programId: "prog-2" }));
		assert.deepEqual(events, ["created"]);

		await stopProgramActor("prog-2", (state) => dummyCtx({ state, programId: "prog-2" }));
		assert.deepEqual(events, ["created", "destroyed"]);
	});

	it("tick loop fires periodically", async () => {
		let tickCount = 0;

		const entry = makeEntry("prog-3", "/ticker", {
			actor: {
				createState: () => ({}),
				tickMs: 10,
				onTick: async () => { tickCount++; },
				actions: {},
			},
		});

		await startProgramActor(entry, (state) => dummyCtx({ state, programId: "prog-3" }));

		// Wait for a few ticks
		await new Promise(resolve => setTimeout(resolve, 55));

		assert.ok(tickCount >= 3, `expected at least 3 ticks, got ${tickCount}`);

		await stopProgramActor("prog-3", (state) => dummyCtx({ state, programId: "prog-3" }));

		// Ticks should stop
		const countAfterStop = tickCount;
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(tickCount, countAfterStop, "ticks should stop after stopProgramActor");
	});

	it("unknown action throws", async () => {
		const entry = makeEntry("prog-4", "/test", {
			actor: {
				createState: () => ({}),
				actions: { hello: () => "world" },
			},
		});

		await startProgramActor(entry, (state) => dummyCtx({ state, programId: "prog-4" }));

		await assert.rejects(
			() => dispatchActorAction("prog-4", "nonexistent", [], (state) => dummyCtx({ state })),
			/Unknown action/,
		);

		await stopProgramActor("prog-4", (state) => dummyCtx({ state, programId: "prog-4" }));
	});
});

describe("emit", () => {
	it("ctx.emit calls the provided emit function", async () => {
		const emitted: { channel: string; data: any }[] = [];

		const entry = makeEntry("prog-5", "/emitter", {
			actor: {
				createState: () => ({}),
				actions: {
					fire: (ctx) => {
						ctx.emit("test:event", { value: 42 });
					},
				},
			},
		});

		await startProgramActor(entry, (state) => dummyCtx({
			state,
			programId: "prog-5",
			emit: (channel, data) => emitted.push({ channel, data }),
		}));

		await dispatchActorAction(
			"prog-5", "fire", [],
			(state) => dummyCtx({
				state,
				programId: "prog-5",
				emit: (channel, data) => emitted.push({ channel, data }),
			}),
		);

		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].channel, "test:event");
		assert.deepEqual(emitted[0].data, { value: 42 });

		await stopProgramActor("prog-5", (state) => dummyCtx({ state, programId: "prog-5" }));
	});
});
