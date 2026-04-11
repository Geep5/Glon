/**
 * DAG replay tests — the core invariant of Glon OS.
 *
 * "Any peer can recompute state from changes alone."
 *
 * Uses Node's built-in test runner (no deps). Run:
 *   npx tsx --test test/dag.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeState, findHeads, toSnapshot } from "../src/dag/dag.js";
import {
	createChange,
	createGenesisChange,
	createFieldChange,
	createDeleteChange,
	createContentChange,
} from "../src/dag/change.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, unwrapValue, displayValue, encodeChange, decodeChange, encodeChangeForHashing } from "../src/proto.js";
import type { Change, Value } from "../src/proto.js";
import { hexEncode, sha256 } from "../src/crypto.js";

// ── Helpers ──────────────────────────────────────────────────────

/** Shuffle an array in-place (Fisher-Yates). */
function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/** Extract a string field from computed state. */
function fieldStr(state: ReturnType<typeof computeState>, key: string): string | null {
	const v = state.fields.get(key);
	if (!v) return null;
	const raw = unwrapValue(v);
	return typeof raw === "string" ? raw : null;
}

/** Extract a number field from computed state. */
function fieldInt(state: ReturnType<typeof computeState>, key: string): number | null {
	const v = state.fields.get(key);
	if (!v) return null;
	const raw = unwrapValue(v);
	return typeof raw === "number" ? raw : null;
}

// ── Tests ────────────────────────────────────────────────────────

describe("computeState", () => {
	it("single genesis change sets typeKey", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const state = computeState([genesis]);
		assert.equal(state.id, "obj-1");
		assert.equal(state.typeKey, "note");
		assert.equal(state.deleted, false);
		assert.equal(state.fields.size, 0);
	});

	it("genesis + field set produces correct state", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const field = createFieldChange("obj-1", [genesis.id], "title", stringVal("Hello"));
		const state = computeState([genesis, field]);
		assert.equal(fieldStr(state, "title"), "Hello");
	});

	it("field overwrite: last writer wins in topo order", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const set1 = createFieldChange("obj-1", [genesis.id], "title", stringVal("First"));
		const set2 = createFieldChange("obj-1", [set1.id], "title", stringVal("Second"));
		const state = computeState([genesis, set1, set2]);
		assert.equal(fieldStr(state, "title"), "Second");
	});

	it("field delete removes the field", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const set = createFieldChange("obj-1", [genesis.id], "title", stringVal("Hello"));
		const del = createChange("obj-1", [{ fieldDelete: { key: "title" } }], [set.id]);
		const state = computeState([genesis, set, del]);
		assert.equal(state.fields.has("title"), false);
	});

	it("content set stores bytes", () => {
		const genesis = createGenesisChange("obj-1", "file");
		const content = createContentChange("obj-1", [genesis.id], Buffer.from("file data"));
		const state = computeState([genesis, content]);
		assert.equal(Buffer.from(state.content).toString(), "file data");
	});

	it("object delete sets tombstone", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const del = createDeleteChange("obj-1", [genesis.id]);
		const state = computeState([genesis, del]);
		assert.equal(state.deleted, true);
	});

	it("deterministic: same changes, different order → same state", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const a = createFieldChange("obj-1", [genesis.id], "a", stringVal("A"));
		const b = createFieldChange("obj-1", [genesis.id], "b", stringVal("B"));
		// a and b are concurrent (both parent genesis)
		const merge = createFieldChange("obj-1", [a.id, b.id], "c", stringVal("C"));

		// Run 20 random orderings; all must produce identical state.
		const changes = [genesis, a, b, merge];
		const reference = computeState([...changes]);

		for (let i = 0; i < 20; i++) {
			const shuffled = shuffle([...changes]);
			const state = computeState(shuffled);
			assert.equal(fieldStr(state, "a"), fieldStr(reference, "a"), `trial ${i}: field a mismatch`);
			assert.equal(fieldStr(state, "b"), fieldStr(reference, "b"), `trial ${i}: field b mismatch`);
			assert.equal(fieldStr(state, "c"), fieldStr(reference, "c"), `trial ${i}: field c mismatch`);
			assert.equal(state.typeKey, reference.typeKey, `trial ${i}: typeKey mismatch`);
		}
	});

	it("concurrent writes: deterministic conflict resolution", () => {
		// Two changes both set the same field, both parented on genesis.
		// Topo order is determined by hex id (lexicographic). The one
		// with the later hex id wins.
		const genesis = createGenesisChange("obj-1", "note");
		const left = createFieldChange("obj-1", [genesis.id], "winner", stringVal("left"));
		const right = createFieldChange("obj-1", [genesis.id], "winner", stringVal("right"));

		const state1 = computeState([genesis, left, right]);
		const state2 = computeState([genesis, right, left]);

		// Both orderings must resolve the same way.
		assert.equal(fieldStr(state1, "winner"), fieldStr(state2, "winner"));
	});

	it("mixed objectIds throws", () => {
		const a = createGenesisChange("obj-1", "note");
		const b = createGenesisChange("obj-2", "note");
		assert.throws(() => computeState([a, b]), /mixed objectIds/);
	});

	it("empty changes throws", () => {
		assert.throws(() => computeState([]), /no changes/);
	});

	it("block add and remove", () => {
		const genesis = createGenesisChange("obj-1", "page");
		const addBlock = createChange("obj-1", [{
			blockAdd: {
				parentId: "",
				afterId: "",
				block: { id: "blk-1", childrenIds: [], content: { text: { text: "Hello", style: 0 } } },
			},
		}], [genesis.id]);
		const state1 = computeState([genesis, addBlock]);
		assert.equal(state1.blocks.length, 1);
		assert.equal(state1.blocks[0].id, "blk-1");

		const removeBlock = createChange("obj-1", [{ blockRemove: { blockId: "blk-1" } }], [addBlock.id]);
		const state2 = computeState([genesis, addBlock, removeBlock]);
		assert.equal(state2.blocks.length, 0);
	});
});

describe("findHeads", () => {
	it("single change is its own head", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const heads = findHeads([genesis]);
		assert.equal(heads.length, 1);
		assert.equal(hexEncode(heads[0]), hexEncode(genesis.id));
	});

	it("linear chain: only the tip is a head", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const second = createFieldChange("obj-1", [genesis.id], "k", stringVal("v"));
		const heads = findHeads([genesis, second]);
		assert.equal(heads.length, 1);
		assert.equal(hexEncode(heads[0]), hexEncode(second.id));
	});

	it("two concurrent branches: two heads", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const left = createFieldChange("obj-1", [genesis.id], "a", stringVal("1"));
		const right = createFieldChange("obj-1", [genesis.id], "b", stringVal("2"));
		const heads = findHeads([genesis, left, right]);
		assert.equal(heads.length, 2);
		const hexIds = heads.map(h => hexEncode(h)).sort();
		const expected = [hexEncode(left.id), hexEncode(right.id)].sort();
		assert.deepEqual(hexIds, expected);
	});

	it("merge reduces to single head", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const left = createFieldChange("obj-1", [genesis.id], "a", stringVal("1"));
		const right = createFieldChange("obj-1", [genesis.id], "b", stringVal("2"));
		const merge = createChange("obj-1", [], [left.id, right.id]);
		const heads = findHeads([genesis, left, right, merge]);
		assert.equal(heads.length, 1);
		assert.equal(hexEncode(heads[0]), hexEncode(merge.id));
	});
});

describe("unwrapValue falsy values", () => {
	it("intVal(0) round-trips through encode/decode", () => {
		// Create a change with intValue=0, encode, decode, check.
		const genesis = createGenesisChange("obj-1", "note");
		const field = createFieldChange("obj-1", [genesis.id], "count", intVal(0));
		const encoded = encodeChange(field);
		const decoded = decodeChange(encoded);
		const v = decoded.ops[0].fieldSet!.value;
		assert.strictEqual(unwrapValue(v), 0);
	});

	it("boolVal(false) round-trips through encode/decode", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const field = createFieldChange("obj-1", [genesis.id], "active", boolVal(false));
		const encoded = encodeChange(field);
		const decoded = decodeChange(encoded);
		const v = decoded.ops[0].fieldSet!.value;
		assert.strictEqual(unwrapValue(v), false);
	});

	it("stringVal('') round-trips through encode/decode", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const field = createFieldChange("obj-1", [genesis.id], "label", stringVal(""));
		const encoded = encodeChange(field);
		const decoded = decodeChange(encoded);
		const v = decoded.ops[0].fieldSet!.value;
		assert.strictEqual(unwrapValue(v), "");
	});

	it("constructed values (no decode) work too", () => {
		assert.strictEqual(unwrapValue(intVal(0)), 0);
		assert.strictEqual(unwrapValue(boolVal(false)), false);
		assert.strictEqual(unwrapValue(stringVal("")), "");
		assert.strictEqual(unwrapValue(floatVal(0)), 0);
	});

	it("non-zero values still work", () => {
		assert.strictEqual(unwrapValue(intVal(42)), 42);
		assert.strictEqual(unwrapValue(boolVal(true)), true);
		assert.strictEqual(unwrapValue(stringVal("hello")), "hello");
		assert.strictEqual(unwrapValue(floatVal(3.14)), 3.14);
	});
});

describe("displayValue", () => {
	it("displays nested map", () => {
		const v = mapVal({ a: stringVal("1"), b: intVal(2) });
		const d = displayValue(v);
		assert.ok(d.includes("a: 1"), d);
		assert.ok(d.includes("b: 2"), d);
	});

	it("displays list", () => {
		const v = listVal([stringVal("x"), intVal(3)]);
		const d = displayValue(v);
		assert.ok(d.includes("x"), d);
		assert.ok(d.includes("3"), d);
	});

	it("displays zero values correctly", () => {
		assert.equal(displayValue(intVal(0)), "0");
		assert.equal(displayValue(boolVal(false)), "false");
		assert.equal(displayValue(stringVal("")), "");
	});
});

describe("snapshot round-trip", () => {
	it("snapshot embedded in change survives encode/decode", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const field = createFieldChange("obj-1", [genesis.id], "title", stringVal("Test"));
		const state = computeState([genesis, field]);
		const snapshot = toSnapshot(state);

		const change: Change = {
			id: new Uint8Array(0),
			objectId: "obj-1",
			parentIds: [field.id],
			ops: [],
			snapshot,
			timestamp: Date.now(),
			author: "test",
		};

		const encoded = encodeChange(change);
		const decoded = decodeChange(encoded);

		assert.ok(decoded.snapshot, "snapshot should survive encode/decode");
		assert.equal(decoded.snapshot!.typeKey, "note");
		assert.ok(decoded.snapshot!.fields, "snapshot fields should exist");
	});

	it("computeState uses snapshot to skip replay prefix", () => {
		const genesis = createGenesisChange("obj-1", "note");
		const field1 = createFieldChange("obj-1", [genesis.id], "a", stringVal("1"));
		const state1 = computeState([genesis, field1]);
		const snapshot = toSnapshot(state1);

		// Create a snapshot change
		const snapChange: Change = {
			id: new Uint8Array(0),
			objectId: "obj-1",
			parentIds: [field1.id],
			ops: [],
			snapshot,
			timestamp: Date.now(),
			author: "test",
		};
		// Give it a deterministic id for test stability
		snapChange.id = sha256(encodeChangeForHashing(snapChange));

		// Add a change after the snapshot
		const field2 = createFieldChange("obj-1", [snapChange.id], "b", stringVal("2"));

		const finalState = computeState([genesis, field1, snapChange, field2]);
		assert.equal(fieldStr(finalState, "a"), "1"); // from snapshot
		assert.equal(fieldStr(finalState, "b"), "2"); // from post-snapshot change
	});
});
