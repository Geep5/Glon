/**
 * Figgies — single-file state, family-trust setting.
 *
 * All state lives in one JSON document on disk. Every mutation is a signed-by-
 * convention "op" appended to a log; applying an op idempotently is the only
 * way to change state. Peers sync by exchanging ops they haven't seen yet.
 *
 * No cryptographic signatures, no consensus, no double-spend defenses. This
 * is a family chore-tracker. Trust everyone.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ── Paths ──────────────────────────────────────────────────────────

// State lives under ~/.glon — matches the legacy glon path so a single
// directory is the source of truth across both implementations.
const FIGGIES_ROOT = process.env.FIGGIES_ROOT ?? process.env.GLON_ROOT ?? join(homedir(), ".glon");
const STATE_FILE = join(FIGGIES_ROOT, "figgies-state.json");
const WALLET_FILE = join(FIGGIES_ROOT, "wallet.json");

// ── Types ──────────────────────────────────────────────────────────

export type Role = "parent" | "kid";

export interface User {
	balance: number;
	role: Role;
	created_at: number;
}

export interface Bid {
	bidder: string;
	amount: number;
	at: number;
}

export interface Auction {
	id: string;
	seller: string;
	title: string;
	asking: number;          // suggested price; bids can differ
	expires_at: number;
	created_at: number;
	bids: Bid[];
	status: "open" | "settled" | "cancelled";
	winner?: string;
	settled_at?: number;
}

export type Op =
	| { id: string; at: number; kind: "register_user"; name: string; role: Role }
	| { id: string; at: number; kind: "mint"; to: string; amount: number; memo?: string; by: string }
	| { id: string; at: number; kind: "transfer"; from: string; to: string; amount: number; memo?: string }
	| { id: string; at: number; kind: "post_auction"; auction_id: string; seller: string; title: string; asking: number; expires_at: number }
	| { id: string; at: number; kind: "bid"; auction_id: string; bidder: string; amount: number }
	| { id: string; at: number; kind: "settle"; auction_id: string; winner: string; by: string }
	| { id: string; at: number; kind: "cancel"; auction_id: string; by: string };

export interface State {
	users: Record<string, User>;
	auctions: Record<string, Auction>;
	log: Op[];
	seen: Record<string, true>;
}

// ── Disk ───────────────────────────────────────────────────────────

let state: State = loadState();

function loadState(): State {
	if (!existsSync(STATE_FILE)) {
		return { users: {}, auctions: {}, log: [], seen: {} };
	}
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
		return {
			users: raw.users ?? {},
			auctions: raw.auctions ?? {},
			log: raw.log ?? [],
			seen: raw.seen ?? {},
		};
	} catch (err) {
		console.error(`[state] failed to parse ${STATE_FILE} — starting fresh:`, err);
		return { users: {}, auctions: {}, log: [], seen: {} };
	}
}

function saveState(): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Write the local wallet file consumed by Astrolabe's `/api/wallet`.
 *  For Figgies this is just the local device's user. One line. */
export function writeLocalWallet(username: string): void {
	mkdirSync(dirname(WALLET_FILE), { recursive: true });
	writeFileSync(WALLET_FILE, JSON.stringify({ keys: { default: { pubkey: username } } }, null, 2));
}

// ── Public reads ───────────────────────────────────────────────────

export function getState(): State {
	return state;
}

export function listUsers(): Array<{ name: string } & User> {
	return Object.entries(state.users).map(([name, u]) => ({ name, ...u }));
}

export function getUser(name: string): User | undefined {
	return state.users[name];
}

export function listAuctions(): Auction[] {
	return Object.values(state.auctions).sort((a, b) => b.created_at - a.created_at);
}

export function getAuction(id: string): Auction | undefined {
	return state.auctions[id];
}

export function listBids(auctionId: string): Bid[] {
	return state.auctions[auctionId]?.bids ?? [];
}

export function opsSince(opId: string | null): Op[] {
	if (!opId) return state.log;
	const idx = state.log.findIndex((op) => op.id === opId);
	if (idx < 0) return state.log;
	return state.log.slice(idx + 1);
}

// ── Op application ─────────────────────────────────────────────────

export interface ApplyResult {
	ok: boolean;
	error?: string;
}

/** Apply an op to the state and persist. Idempotent on op.id. */
export function applyOp(op: Op): ApplyResult {
	if (state.seen[op.id]) return { ok: true };

	const result = applyInner(op);
	if (!result.ok) return result;

	state.seen[op.id] = true;
	state.log.push(op);
	saveState();
	return { ok: true };
}

function applyInner(op: Op): ApplyResult {
	switch (op.kind) {
		case "register_user": {
			if (state.users[op.name]) return { ok: false, error: `user already exists: ${op.name}` };
			state.users[op.name] = { balance: 0, role: op.role, created_at: op.at };
			return { ok: true };
		}
		case "mint": {
			const u = state.users[op.to];
			if (!u) return { ok: false, error: `unknown user: ${op.to}` };
			const minter = state.users[op.by];
			if (!minter) return { ok: false, error: `unknown minter: ${op.by}` };
			if (minter.role !== "parent") return { ok: false, error: `only parents can mint` };
			if (op.amount <= 0) return { ok: false, error: `amount must be positive` };
			u.balance += op.amount;
			return { ok: true };
		}
		case "transfer": {
			const from = state.users[op.from];
			const to = state.users[op.to];
			if (!from) return { ok: false, error: `unknown sender: ${op.from}` };
			if (!to) return { ok: false, error: `unknown recipient: ${op.to}` };
			if (op.from === op.to) return { ok: false, error: `cannot transfer to self` };
			if (op.amount <= 0) return { ok: false, error: `amount must be positive` };
			if (from.balance < op.amount) return { ok: false, error: `insufficient balance` };
			from.balance -= op.amount;
			to.balance += op.amount;
			return { ok: true };
		}
		case "post_auction": {
			if (state.auctions[op.auction_id]) return { ok: false, error: `auction already exists` };
			if (!state.users[op.seller]) return { ok: false, error: `unknown seller: ${op.seller}` };
			if (op.asking < 0) return { ok: false, error: `asking must be non-negative` };
			if (op.expires_at <= op.at) return { ok: false, error: `expires_at must be in the future` };
			state.auctions[op.auction_id] = {
				id: op.auction_id,
				seller: op.seller,
				title: op.title,
				asking: op.asking,
				expires_at: op.expires_at,
				created_at: op.at,
				bids: [],
				status: "open",
			};
			return { ok: true };
		}
		case "bid": {
			const a = state.auctions[op.auction_id];
			if (!a) return { ok: false, error: `unknown auction: ${op.auction_id}` };
			if (a.status !== "open") return { ok: false, error: `auction not open` };
			if (op.at > a.expires_at) return { ok: false, error: `auction expired` };
			const bidder = state.users[op.bidder];
			if (!bidder) return { ok: false, error: `unknown bidder: ${op.bidder}` };
			if (op.bidder === a.seller) return { ok: false, error: `seller cannot bid on own auction` };
			if (op.amount <= 0) return { ok: false, error: `amount must be positive` };
			if (bidder.balance < op.amount) return { ok: false, error: `insufficient balance` };
			a.bids.push({ bidder: op.bidder, amount: op.amount, at: op.at });
			return { ok: true };
		}
		case "settle": {
			const a = state.auctions[op.auction_id];
			if (!a) return { ok: false, error: `unknown auction: ${op.auction_id}` };
			if (a.status !== "open") return { ok: false, error: `auction not open` };
			const actor = state.users[op.by];
			if (!actor) return { ok: false, error: `unknown actor: ${op.by}` };
			if (op.by !== a.seller && actor.role !== "parent") {
				return { ok: false, error: `only seller or parent can settle` };
			}
			const winningBid = a.bids.find((b) => b.bidder === op.winner);
			if (!winningBid) return { ok: false, error: `no bid from ${op.winner}` };
			const winner = state.users[op.winner];
			const seller = state.users[a.seller];
			if (!winner || !seller) return { ok: false, error: `users missing for settle` };
			if (winner.balance < winningBid.amount) return { ok: false, error: `winner can no longer afford bid` };
			winner.balance -= winningBid.amount;
			seller.balance += winningBid.amount;
			a.status = "settled";
			a.winner = op.winner;
			a.settled_at = op.at;
			return { ok: true };
		}
		case "cancel": {
			const a = state.auctions[op.auction_id];
			if (!a) return { ok: false, error: `unknown auction: ${op.auction_id}` };
			if (a.status !== "open") return { ok: false, error: `auction not open` };
			const actor = state.users[op.by];
			if (!actor) return { ok: false, error: `unknown actor: ${op.by}` };
			if (op.by !== a.seller && actor.role !== "parent") {
				return { ok: false, error: `only seller or parent can cancel` };
			}
			a.status = "cancelled";
			return { ok: true };
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────

export function newOpId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newAuctionId(): string {
	return `auc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
