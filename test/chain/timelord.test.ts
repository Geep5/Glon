import { describe, it } from "node:test";
import assert from "node:assert";
import { __test } from "../../src/programs/handlers/timelord.js";
import { hexEncode } from "../../src/crypto.js";

const { computeVDF, verifyVDF, deriveChallenge, DEFAULT_VDF_ITERATIONS, MIN_ITERATIONS } = __test;

describe("timelord / compute + verify", () => {
	it("computes and verifies a VDF", () => {
		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);
		const output = computeVDF(challenge, 100_000);
		assert.strictEqual(output.challengeHex, hexEncode(challenge));
		assert.strictEqual(output.iterations, 100_000);
		assert.strictEqual(output.resultHex.length, 64);
		assert.ok(output.durationMs >= 0);
		assert.ok(output.ips > 0);

		const valid = verifyVDF(output);
		assert.strictEqual(valid, true);
	});

	it("rejects tampered VDF output", () => {
		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);
		const output = computeVDF(challenge, 100_000);
		const tampered = { ...output, resultHex: "00".repeat(32) };
		const valid = verifyVDF(tampered);
		assert.strictEqual(valid, false);
	});

	it("rejects VDF with wrong iteration count", () => {
		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);
		const output = computeVDF(challenge, 100_000);
		const tampered = { ...output, iterations: 99_999 };
		const valid = verifyVDF(tampered);
		assert.strictEqual(valid, false);
	});

	it("throws on iterations below minimum", () => {
		const challenge = new Uint8Array(32);
		assert.throws(() => computeVDF(challenge, MIN_ITERATIONS - 1), /iterations must be/);
	});
});

describe("timelord / deriveChallenge", () => {
	it("produces deterministic challenges from merkle root", () => {
		const c1 = deriveChallenge("abcd1234");
		const c2 = deriveChallenge("abcd1234");
		assert.deepStrictEqual(c1, c2);
	});

	it("produces different challenges for different roots", () => {
		const c1 = deriveChallenge("abcd1234");
		const c2 = deriveChallenge("wxyz5678");
		assert.notDeepStrictEqual(c1, c2);
	});

	it("produces 32-byte challenges", () => {
		const c = deriveChallenge("test-root-hex");
		assert.strictEqual(c.length, 32);
	});
});

describe("timelord / constants", () => {
	it("DEFAULT_VDF_ITERATIONS is 5_000_000", () => {
		assert.strictEqual(DEFAULT_VDF_ITERATIONS, 5_000_000);
	});

	it("MIN_ITERATIONS is 100_000", () => {
		assert.strictEqual(MIN_ITERATIONS, 100_000);
	});
});