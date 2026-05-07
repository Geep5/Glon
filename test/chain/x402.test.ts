/**
 * x402 payment authorization tests.
 *
 * Run: npx tsx --test test/chain/x402.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { generateKeyPair, sign as ed25519Sign } from "../../src/det/ed25519.js";
import { hexEncode, hexDecode } from "../../src/crypto.js";
import type { Change } from "../../src/proto.js";

import { randomBytes } from "node:crypto";

	import {
		canonicalAuthBytes,
		verifyX402Auth,
	} from "../../src/programs/handlers/coin-x402.js";

const {
	consensusGate,
	loadState,
	resetMirror,
	recordX402Accepted,
} = (await import("../../src/programs/handlers/consensus.js")).__test;

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

function x402Change(opts: {
	nonce?: number;
	fee?: number;
	pubkey?: Uint8Array;
	x402Auth?: { nonce: Uint8Array; validAfter: number; validBefore: number };
}): Change {
	const pub = opts.pubkey ?? ALICE.publicKey;
	return {
		id: new Uint8Array(0),
		objectId: "bucket-1",
		parentIds: [],
		ops: [
			{
				blockAdd: {
					parentId: "",
					afterId: "",
					block: {
						id: "b1",
						childrenIds: [],
						content: {
							custom: {
								contentType: "chain.coin.op",
								data: new Uint8Array(0),
								meta: { op: "spend", coin_id: "c1" },
							},
						},
					},
				},
			},
		],
		timestamp: Date.now(),
		author: "test",
		authorSig: {
			pubkey: pub,
			signature: new Uint8Array(64),
			nonce: opts.nonce ?? 1,
			fee: opts.fee ?? 1,
		},
		x402Auth: opts.x402Auth,
	};
}

beforeEach(() => {
	resetMirror();
});

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

// ── consensusGate with x402Auth ──────────────────────────────────

describe("consensusGate — x402 path", () => {
	it("accepts a valid x402 change", () => {
		const now = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(32);
		const change = x402Change({
			nonce: 1,
			fee: 1,
			x402Auth: { nonce, validAfter: now - 10, validBefore: now + 60 },
		});
		const state = loadState({});
		const result = consensusGate(change, state, now);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.ok(result.nextState.authNonces.includes(hexEncode(nonce)));
		}
	});

	it("rejects replayed x402 nonce", () => {
		const now = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(32);
		const state = loadState({ authNonces: [hexEncode(nonce)] });
		const change = x402Change({
			nonce: 2,
			fee: 1,
			x402Auth: { nonce, validAfter: now - 10, validBefore: now + 60 },
		});
		const result = consensusGate(change, state, now);
		assert.strictEqual(result.ok, false);
		assert.ok((result as any).reason.includes("x402 nonce replay"));
	});

	it("rejects expired authorization", () => {
		const now = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(32);
		const change = x402Change({
			nonce: 1,
			fee: 1,
			x402Auth: { nonce, validAfter: now - 120, validBefore: now - 60 },
		});
		const state = loadState({});
		const result = consensusGate(change, state, now);
		assert.strictEqual(result.ok, false);
		assert.ok((result as any).reason.includes("expired"));
	});

	it("rejects not-yet-valid authorization", () => {
		const now = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(32);
		const change = x402Change({
			nonce: 1,
			fee: 1,
			x402Auth: { nonce, validAfter: now + 60, validBefore: now + 120 },
		});
		const state = loadState({});
		const result = consensusGate(change, state, now);
		assert.strictEqual(result.ok, false);
		assert.ok((result as any).reason.includes("not yet valid"));
	});

	it("advances monotonic nonce for x402 change", () => {
		const now = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(32);
		const state = loadState({ nonces: { [ALICE_PUB]: 5 } });
		const change = x402Change({
			nonce: 7,
			fee: 1,
			x402Auth: { nonce, validAfter: now - 10, validBefore: now + 60 },
		});
		const result = consensusGate(change, state, now);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.nextState.nonces[ALICE_PUB], 7);
		}
	});
});
