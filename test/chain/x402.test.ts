/**
 * x402 payment authorization tests.
 *
 * Run: npx tsx --test test/chain/x402.test.ts
 */

	import { describe, it } from "node:test";
	import assert from "node:assert";
	import { generateKeyPair, sign as ed25519Sign } from "../../src/det/ed25519.js";
	import { hexEncode, hexDecode } from "../../src/crypto.js";
	import { randomBytes } from "node:crypto";
	import {
		canonicalAuthBytes,
		verifyX402Auth,
	} from "../../src/programs/handlers/coin-x402.js";
const ALICE = generateKeyPair();
const BOB = generateKeyPair();
const ALICE_PUB = hexEncode(ALICE.publicKey);
const BOB_PUB = hexEncode(BOB.publicKey);

function makeAuth(opts?: {
	from?: string;
	to?: string;
	value?: string;
	asset?: string;
	validAfter?: number;
	validBefore?: number;
	nonce?: string;
}) {
	const now = Math.floor(Date.now() / 1000);
	return {
		scheme: "exact" as const,
		network: "glon:v1" as const,
		from: opts?.from ?? ALICE_PUB,
		to: opts?.to ?? BOB_PUB,
		value: opts?.value ?? "100",
		asset: opts?.asset ?? "token-1",
		validAfter: opts?.validAfter ?? now - 10,
		validBefore: opts?.validBefore ?? now + 60,
		nonce: opts?.nonce ?? hexEncode(randomBytes(32)),
	};
}

function signAuth(auth: ReturnType<typeof makeAuth>) {

	const msg = canonicalAuthBytes(auth);
	const sig = ed25519Sign(ALICE.privateKey, msg);
	return hexEncode(sig);
}



// ── canonicalAuthBytes ───────────────────────────────────────────

describe("canonicalAuthBytes", () => {
	it("is deterministic", () => {
		const auth = makeAuth();
		const a = canonicalAuthBytes(auth);
		const b = canonicalAuthBytes(auth);
		assert.deepStrictEqual(a, b);
	});

	it("orders keys lexicographically", () => {
		const auth = makeAuth();
		const bytes = canonicalAuthBytes(auth);
		const json = new TextDecoder().decode(bytes);
		assert.ok(json.indexOf('"asset"') < json.indexOf('"from"'));
		assert.ok(json.indexOf('"from"') < json.indexOf('"network"'));
	});
});

// ── verifyX402Auth ───────────────────────────────────────────────

describe("verifyX402Auth", () => {
	it("accepts a valid signature", () => {
		const auth = makeAuth();
		const sig = signAuth(auth);
		assert.strictEqual(verifyX402Auth(auth, sig), true);
	});

	it("rejects an invalid signature", () => {
		const auth = makeAuth();
		const badSig = "0".repeat(128);
		assert.strictEqual(verifyX402Auth(auth, badSig), false);
	});

	it("rejects a tampered authorization", () => {
		const auth = makeAuth();
		const sig = signAuth(auth);
		const tampered = { ...auth, value: "200" };
		assert.strictEqual(verifyX402Auth(tampered, sig), false);
	});
});


