import { describe, it } from "node:test";
import assert from "node:assert";
import { __test } from "../../src/programs/handlers/plot.js";
import { hexEncode } from "../../src/crypto.js";

const { xor256, compare256, createPlot, findProof, verifyProof, DEFAULT_PLOT_ENTRIES } = __test;

describe("plot / math", () => {
	it("xor256 returns correct XOR", () => {
		const a = new Uint8Array([0xff, 0x00, 0xaa, 0x55]);
		const b = new Uint8Array([0x00, 0xff, 0x55, 0xaa]);
		const result = xor256(a, b);
		assert.strictEqual(result[0], 0xff);
		assert.strictEqual(result[1], 0xff);
		assert.strictEqual(result[2], 0xff);
		assert.strictEqual(result[3], 0xff);
	});

	it("compare256 compares lexicographically", () => {
		const a = new Uint8Array([0x00, 0x00]);
		const b = new Uint8Array([0x00, 0x01]);
		assert.strictEqual(compare256(a, b), -1);
		assert.strictEqual(compare256(b, a), 1);
		assert.strictEqual(compare256(a, a), 0);
	});
});

describe("plot / create + prove + verify", () => {
	it("creates a small plot, finds proof, verifies it", async () => {
		const { path, entries, sizeBytes } = await createPlot("test-plot", 1000, "test-pubkey");
		assert.strictEqual(entries, 1000);
		assert.ok(sizeBytes > 0);

		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);

		const proof = findProof(path, challenge, "test-plot");
		assert.ok(proof);
		assert.strictEqual(proof!.plotName, "test-plot");
		assert.strictEqual(proof!.challengeHex, hexEncode(challenge));
		assert.ok(proof!.quality >= 0);
		assert.ok(proof!.entryIndex >= 0 && proof!.entryIndex < 1000);

		const valid = verifyProof(proof!, challenge, path);
		assert.strictEqual(valid, true);
	});

	it("rejects tampered proof", async () => {
		const { path } = await createPlot("test-plot-2", 500, "test-pubkey");
		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);

		const proof = findProof(path, challenge, "test-plot-2")!;
		const tampered = { ...proof, bestHashHex: "00".repeat(32) };
		const valid = verifyProof(tampered, challenge, path);
		assert.strictEqual(valid, false);
	});

	it("rejects proof with wrong challenge", async () => {
		const { path } = await createPlot("test-plot-3", 500, "test-pubkey");
		const challenge1 = new Uint8Array(32);
		crypto.getRandomValues(challenge1);
		const challenge2 = new Uint8Array(32);
		crypto.getRandomValues(challenge2);

		const proof = findProof(path, challenge1, "test-plot-3")!;
		const valid = verifyProof(proof, challenge2, path);
		assert.strictEqual(valid, false);
	});
});

describe("plot / constants", () => {
	it("DEFAULT_PLOT_ENTRIES is 1_000_000", () => {
		assert.strictEqual(DEFAULT_PLOT_ENTRIES, 1_000_000);
	});
});