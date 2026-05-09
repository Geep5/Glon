// Coin shared types and constants — zero runtime dependencies.
//
// This module contains only types, constants, and tiny pure helpers
// used by both coin-bucket.ts and coin-offer.ts.

import type { Block, Change } from "../../proto.js";

export const TOKEN_TYPE_KEY = "chain.token";
export const BUCKET_TYPE_KEY = "chain.coin.bucket";
export const OFFER_TYPE_KEY = "chain.coin.offer";
export const OP_CONTENT_TYPE = "chain.coin.op";
export const MAX_COINS_PER_BUCKET = 1000;

export interface TokenMeta {
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkey: string;
	totalSupply: bigint;
	mintRenounced: boolean;
}

export interface CoinOp {
	kind: "create" | "spend" | "offer_escrow" | "offer_pay" | "offer_settle" | "offer_cancel";
	coinId: string;
	ownerPubkey?: string;
	amount?: string;
	tokenId?: string;
	outputs?: string; // JSON array for offer_settle
	// Anchor fields — every coin op is an anchor
	state_root?: string;      // hex-encoded 32-byte SHA-256
	prev_anchor_id?: string;  // hex-encoded 32-byte change id (empty for genesis-following)
	pospace_proof?: string;   // hex-encoded proof bytes (optional)
}

export interface OfferTerms {
	offered: Array<{ tokenId: string; amount: string }>;
	requested: Array<{ tokenId: string; amount: string }>;
}

export interface BucketState {
	tokenId: string;
	coins: Map<string, { owner: string; amount: string; spent: boolean }>;
}

export interface OfferState {
	status: "open" | "funded" | "settled" | "cancelled";
	escrowed: Map<string, { owner: string; amount: string; tokenId: string; spent: boolean }>;
	payments: Map<string, { owner: string; amount: string; tokenId: string; spent: boolean }>;
	outputs: Map<string, { owner: string; amount: string; tokenId: string }>;
}

// ── Op decoding ────────────────────────────────────────────────────

export function decodeCoinOp(block: Block): CoinOp | null {
	const custom = block.content?.custom;
	if (!custom || custom.contentType !== OP_CONTENT_TYPE) return null;
	const meta = custom.meta as Record<string, string> | undefined;
	if (!meta) return null;
	const kind = meta.op;
	const validKinds = ["create", "spend", "offer_escrow", "offer_pay", "offer_settle", "offer_cancel"];
	if (!kind || !validKinds.includes(kind)) return null;
	const op: CoinOp = { kind: kind as CoinOp["kind"], coinId: meta.coin_id ?? "" };
	if (kind === "create" || kind === "offer_escrow" || kind === "offer_pay") {
		op.ownerPubkey = meta.owner_pubkey;
		op.amount = meta.amount;
		op.tokenId = meta.token_id;
	}
	if (kind === "offer_settle") {
		op.outputs = meta.outputs;
	}
	// Anchor fields
	if (meta.state_root !== undefined) op.state_root = meta.state_root;
	if (meta.prev_anchor_id !== undefined) op.prev_anchor_id = meta.prev_anchor_id;
	if (meta.pospace_proof !== undefined) op.pospace_proof = meta.pospace_proof;
	return op;
}

export function encodeCoinOp(op: CoinOp): Record<string, string> {
	const out: Record<string, string> = { op: op.kind, coin_id: op.coinId };
	if (op.ownerPubkey !== undefined) out.owner_pubkey = op.ownerPubkey;
	if (op.amount !== undefined) out.amount = op.amount;
	if (op.tokenId !== undefined) out.token_id = op.tokenId;
	if (op.outputs !== undefined) out.outputs = op.outputs;
	if (op.state_root !== undefined) out.state_root = op.state_root;
	if (op.prev_anchor_id !== undefined) out.prev_anchor_id = op.prev_anchor_id;
	if (op.pospace_proof !== undefined) out.pospace_proof = op.pospace_proof;
	return out;
}

// ── Tiny field helpers used across coin modules ────────────────────

export function extractStr(v: any): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return "";
}

export function extractInt(v: any, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = Number(v.intValue);
		return Number.isFinite(n) ? n : fallback;
	}
	if (v.floatValue !== undefined) {
		const n = Number(v.floatValue);
		return Number.isFinite(n) ? Math.floor(n) : fallback;
	}
	return fallback;
}

export function extractBool(v: any): boolean {
	if (v === null || v === undefined) return false;
	if (typeof v === "boolean") return v;
	if (v.boolValue !== undefined) return !!v.boolValue;
	return false;
}

// ── Anchor helpers ─────────────────────────────────────────────────

import { sha256, hexEncode } from "../../crypto.js";

/** Compute SHA-256 state root over a bucket's canonical state. */
export function computeStateRoot(bucketState: BucketState): Uint8Array {
	const entries = Array.from(bucketState.coins.entries()).sort(([a], [b]) => a.localeCompare(b));
	const canonical = JSON.stringify({
		tokenId: bucketState.tokenId,
		coins: entries.map(([id, c]) => ({ id, owner: c.owner, amount: c.amount, spent: c.spent })),
	});
	return sha256(new TextEncoder().encode(canonical));
}

/** Find the most recent coin-op block's change id to chain prev_anchor_id to.
 *  Returns "" if this is the first coin op (no prior coin-op blocks).
 */
export function findPrevAnchorId(
	blocks: Block[],
	blockProvenance: Map<string, { changeId: Uint8Array; timestamp: number }>,
): string {
	let latest: { changeId: Uint8Array; timestamp: number } | null = null;
	for (const block of blocks) {
		if (block.content?.custom?.contentType !== OP_CONTENT_TYPE) continue;
		const prov = blockProvenance.get(block.id);
		if (!prov) continue;
		if (!latest || prov.timestamp > latest.timestamp) {
			latest = prov;
		}
	}
	return latest ? hexEncode(latest.changeId) : "";
}
