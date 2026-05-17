/**
 * Figgies — local daemon.
 *
 * One process per family device. Owns this device's view of the shared
 * state. Listens on :6430 for HTTP /dispatch from Astrolabe (the UI) and
 * /ops for peer sync. Polls configured peers every 5s to pull new ops.
 *
 * Env:
 *   FIGGIES_USER       — this device's user name (e.g., "mom", "kid1")
 *   FIGGIES_PORT       — HTTP port (default 6430)
 *   FIGGIES_PEERS      — comma-separated peer URLs (optional)
 *   FIGGIES_ROOT       — state directory (default ~/.figgies)
 *   FIGGIES_AUTO_PARENT — if "1", register the local user as parent on first run
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	applyOp,
	getState,
	getUser,
	listUsers,
	listAuctions,
	getAuction,
	listBids,
	opsSince,
	newOpId,
	newAuctionId,
	writeLocalWallet,
	type Op,
	type Role,
} from "../src/state.js";
import { startSync, peerStatus } from "../src/sync.js";

const PORT = Number(process.env.FIGGIES_PORT ?? 6430);
const ME = process.env.FIGGIES_USER ?? "";
const AUTO_PARENT = process.env.FIGGIES_AUTO_PARENT === "1";

if (!ME) {
	console.error("[figgies] FIGGIES_USER is required (e.g. FIGGIES_USER=mom)");
	process.exit(1);
}

// First-run: ensure this device's user exists, optionally as parent.
function ensureLocalUser(): void {
	if (getUser(ME)) return;
	if (!AUTO_PARENT) {
		console.log(`[figgies] user "${ME}" not registered yet — set FIGGIES_AUTO_PARENT=1 to self-register as parent, or have a parent register you via /dispatch /family register`);
		return;
	}
	const op: Op = { id: newOpId(), at: Date.now(), kind: "register_user", name: ME, role: "parent" };
	const r = applyOp(op);
	if (r.ok) console.log(`[figgies] self-registered "${ME}" as parent`);
}

ensureLocalUser();
writeLocalWallet(ME);

// ── HTTP helpers ───────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	});
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (chunks.length === 0) return null;
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw) return null;
	return JSON.parse(raw);
}

// ── Dispatch handlers ──────────────────────────────────────────────

type DispatchResult = { ok: true; result: unknown } | { ok: false; error: string };

function dispatch(prefix: string, action: string, args: unknown[]): DispatchResult {
	switch (prefix) {
		case "/auction":
			return dispatchAuction(action, args);
		case "/coin":
			return dispatchCoin(action, args);
		case "/family":
			return dispatchFamily(action, args);
		default:
			return { ok: false, error: `unknown program: ${prefix}` };
	}
}

function dispatchAuction(action: string, args: unknown[]): DispatchResult {
	switch (action) {
		case "status": {
			return {
				ok: true,
				result: {
					backend: "figgies",
					bootstrap_key: "family",
					writer_pubkey: ME,
					view_length: getState().log.length,
					system_length: getState().log.length,
					known_writers: Object.keys(getState().users).length,
				},
			};
		}
		case "list": {
			const auctions = listAuctions().map((a) => ({
				kind: "auction.create",
				id: a.id,
				seller_pubkey: a.seller,
				give: [{ object_id: a.title }],
				want: [{ token: "figgies", amount: String(a.asking) }],
				expiry_ms: a.expires_at,
				created_at: a.created_at,
				signature: "",
				status: a.status,
				recipient_pubkey: undefined,
			}));
			return { ok: true, result: auctions };
		}
		case "getBids": {
			const id = args[0] as string;
			const bids = listBids(id).map((b) => ({
				auction_id: id,
				bidder_pubkey: b.bidder,
				offer: [{ token: "figgies", amount: String(b.amount) }],
				created_at: b.at,
				signature: "",
			}));
			bids.sort((a, b) => b.created_at - a.created_at);
			return { ok: true, result: bids };
		}
		case "post": {
			const body = (args[0] ?? {}) as {
				give?: Array<{ object_id?: string; token?: string; amount?: string }>;
				want?: Array<{ token?: string; amount?: string }>;
				expiryMs?: number;
			};
			const title =
				body.give?.[0]?.object_id ??
				(body.give?.[0]?.token ? `${body.give[0].amount} ${body.give[0].token}` : "untitled");
			const asking = Number(body.want?.[0]?.amount ?? 0);
			const expires_at = Number(body.expiryMs ?? Date.now() + 24 * 60 * 60 * 1000);
			const auction_id = newAuctionId();
			const op: Op = {
				id: newOpId(),
				at: Date.now(),
				kind: "post_auction",
				auction_id,
				seller: ME,
				title,
				asking,
				expires_at,
			};
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "post failed" };
			return { ok: true, result: { auction_id } };
		}
		case "bid": {
			const body = (args[0] ?? {}) as {
				auctionId?: string;
				offer?: Array<{ token?: string; amount?: string }>;
			};
			if (!body.auctionId) return { ok: false, error: "auctionId required" };
			const amount = Number(body.offer?.[0]?.amount ?? 0);
			if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be positive" };
			const op: Op = {
				id: newOpId(),
				at: Date.now(),
				kind: "bid",
				auction_id: body.auctionId,
				bidder: ME,
				amount,
			};
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "bid failed" };
			return { ok: true, result: {} };
		}
		case "settle": {
			const body = (args[0] ?? {}) as { auctionId?: string; winner?: string };
			if (!body.auctionId || !body.winner) return { ok: false, error: "auctionId and winner required" };
			const op: Op = {
				id: newOpId(),
				at: Date.now(),
				kind: "settle",
				auction_id: body.auctionId,
				winner: body.winner,
				by: ME,
			};
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "settle failed" };
			return { ok: true, result: {} };
		}
		case "cancel": {
			const body = (args[0] ?? {}) as { auctionId?: string };
			if (!body.auctionId) return { ok: false, error: "auctionId required" };
			const op: Op = {
				id: newOpId(),
				at: Date.now(),
				kind: "cancel",
				auction_id: body.auctionId,
				by: ME,
			};
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "cancel failed" };
			return { ok: true, result: {} };
		}
		default:
			return { ok: false, error: `unknown /auction action: ${action}` };
	}
}

function dispatchCoin(action: string, _args: unknown[]): DispatchResult {
	switch (action) {
		case "list": {
			// One synthetic token: figgies. Total "supply" = sum of all balances.
			const users = listUsers();
			const supply = users.reduce((sum, u) => sum + u.balance, 0);
			return {
				ok: true,
				result: [
					{
						kind: "coin.deploy",
						token_id: "figgies",
						name: "Figgies",
						symbol: "FIG",
						decimals: 0,
						supply: String(supply),
						owner_pubkey: users.find((u) => u.role === "parent")?.name ?? ME,
						mint_renounced: false,
						created_at: 0,
						signature: "",
					},
				],
			};
		}
		case "holders": {
			const holders = listUsers()
				.filter((u) => u.balance > 0)
				.map((u) => ({ pubkey: u.name, balance: String(u.balance) }));
			return { ok: true, result: holders };
		}
		default:
			return { ok: false, error: `unknown /coin action: ${action}` };
	}
}

function dispatchFamily(action: string, args: unknown[]): DispatchResult {
	switch (action) {
		case "list":
			return { ok: true, result: listUsers() };
		case "me":
			return { ok: true, result: { name: ME, user: getUser(ME) ?? null } };
		case "register": {
			const body = (args[0] ?? {}) as { name?: string; role?: Role };
			if (!body.name) return { ok: false, error: "name required" };
			if (body.role !== "parent" && body.role !== "kid") return { ok: false, error: "role must be parent or kid" };
			const op: Op = { id: newOpId(), at: Date.now(), kind: "register_user", name: body.name, role: body.role };
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "register failed" };
			return { ok: true, result: {} };
		}
		case "mint": {
			const body = (args[0] ?? {}) as { to?: string; amount?: number; memo?: string };
			if (!body.to) return { ok: false, error: "to required" };
			const amount = Number(body.amount ?? 0);
			if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be positive" };
			const op: Op = { id: newOpId(), at: Date.now(), kind: "mint", to: body.to, amount, memo: body.memo, by: ME };
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "mint failed" };
			return { ok: true, result: {} };
		}
		case "transfer": {
			const body = (args[0] ?? {}) as { to?: string; amount?: number; memo?: string };
			if (!body.to) return { ok: false, error: "to required" };
			const amount = Number(body.amount ?? 0);
			if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be positive" };
			const op: Op = { id: newOpId(), at: Date.now(), kind: "transfer", from: ME, to: body.to, amount, memo: body.memo };
			const r = applyOp(op);
			if (!r.ok) return { ok: false, error: r.error ?? "transfer failed" };
			return { ok: true, result: {} };
		}
		case "log":
			return { ok: true, result: getState().log };
		case "peers":
			return { ok: true, result: peerStatus() };
		default:
			return { ok: false, error: `unknown /family action: ${action}` };
	}
}

// ── Server ─────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
	if (req.method === "OPTIONS") {
		send(res, 204, {});
		return;
	}
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

	try {
		if (req.method === "POST" && url.pathname === "/dispatch") {
			const body = (await readBody(req)) ?? {};
			const result = dispatch(body.prefix ?? "", body.action ?? "", body.args ?? []);
			send(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "GET" && url.pathname === "/ops") {
			const since = url.searchParams.get("since");
			const ops = opsSince(since);
			send(res, 200, { ops });
			return;
		}

		if (req.method === "GET" && url.pathname === "/state") {
			send(res, 200, getState());
			return;
		}

		if (req.method === "GET" && url.pathname === "/health") {
			send(res, 200, { ok: true, user: ME, users: Object.keys(getState().users).length, auctions: Object.keys(getState().auctions).length });
			return;
		}

		send(res, 404, { ok: false, error: "not found" });
	} catch (err: any) {
		send(res, 500, { ok: false, error: err?.message ?? String(err) });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[figgies] daemon listening on 127.0.0.1:${PORT} as "${ME}"`);
	startSync();
});

// Heartbeat so logs show liveness.
setInterval(() => {
	const s = getState();
	console.log(`[figgies] alive — ${Object.keys(s.users).length} user(s), ${Object.keys(s.auctions).length} auction(s), ${s.log.length} op(s)`);
}, 60_000);
