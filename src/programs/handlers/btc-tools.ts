// btc-tools — market-data + trading actions for the BTC agent.
//
// Two backends:
//
//   alpaca_*       Alpaca Markets — spot crypto market data + paper trading.
//                  Requires ALPACA_API_KEY and ALPACA_SECRET_KEY in env.
//                  Crypto market data is free; paper trading uses the
//                  paper-trading endpoint (no real money at risk).
//
//   hyperliquid_*  Hyperliquid perpetuals DEX. Public read endpoints
//                  (price, order book, any wallet's positions) need no
//                  auth. Trading needs EIP-712 signing with
//                  HYPERLIQUID_SECRET_KEY — DEFERRED for v1 because it
//                  has a non-trivial typed-data signature requirement
//                  that ethers/web3 would otherwise pull into the bundle.
//
// All credentials are loaded from process.env (which the env.ts loader
// also reads from ~/.glon/secrets.env). The agent that owns these tools
// addresses them by name — see the registerTool calls a downstream
// script can issue, e.g.:
//
//   curl -sS http://127.0.0.1:6430/ -d '{
//     "prefix":"/agent","action":"registerTool",
//     "args":["<btc-agent-id>", {
//       "name":"alpaca_btc_price",
//       "description":"Fetch the latest BTC/USD price bar from Alpaca.",
//       "input_schema": {"type":"object","properties":{}},
//       "target_prefix":"/btc-tools","target_action":"alpacaBTCPrice"
//     }]
//   }'

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";

const ALPACA_DATA_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";
const ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets/v2";
const HYPERLIQUID_API = "https://api.hyperliquid.xyz";

function alpacaHeaders(): Record<string, string> {
	const key = process.env.ALPACA_API_KEY;
	const secret = process.env.ALPACA_SECRET_KEY;
	if (!key || !secret) {
		throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in env (see ~/.glon/secrets.env)");
	}
	return {
		"APCA-API-KEY-ID": key,
		"APCA-API-SECRET-KEY": secret,
		"Accept": "application/json",
	};
}

// ── Alpaca ──────────────────────────────────────────────────────

interface AlpacaPriceInput { symbol?: string }
async function alpacaBTCPrice(_ctx: ProgramContext, input: AlpacaPriceInput = {}) {
	const symbol = input.symbol ?? "BTC/USD";
	const encoded = encodeURIComponent(symbol);
	const url = `${ALPACA_DATA_BASE}/latest/bars?symbols=${encoded}`;
	const res = await fetch(url, { headers: alpacaHeaders() });
	if (!res.ok) throw new Error(`alpaca_btc_price: ${res.status} ${await res.text()}`);
	const json = await res.json() as { bars?: Record<string, { c: number; h: number; l: number; o: number; t: string; v: number }> };
	const bar = json.bars?.[symbol];
	if (!bar) return { symbol, raw: json, error: "no bar in response" };
	return {
		symbol,
		price_usd: bar.c,
		open: bar.o,
		high: bar.h,
		low: bar.l,
		volume: bar.v,
		bar_time: bar.t,
	};
}

interface AlpacaAccountInput {}
async function alpacaAccount(_ctx: ProgramContext, _input: AlpacaAccountInput = {}) {
	const url = `${ALPACA_PAPER_BASE}/account`;
	const res = await fetch(url, { headers: alpacaHeaders() });
	if (!res.ok) throw new Error(`alpaca_account: ${res.status} ${await res.text()}`);
	return await res.json();
}

interface AlpacaPositionsInput {}
async function alpacaPositions(_ctx: ProgramContext, _input: AlpacaPositionsInput = {}) {
	const url = `${ALPACA_PAPER_BASE}/positions`;
	const res = await fetch(url, { headers: alpacaHeaders() });
	if (!res.ok) throw new Error(`alpaca_positions: ${res.status} ${await res.text()}`);
	return await res.json();
}

interface AlpacaOrderInput {
	symbol: string;            // "BTC/USD"
	side: "buy" | "sell";
	qty: number;               // crypto fraction
	type?: "market" | "limit";
	limit_price?: number;
	time_in_force?: "gtc" | "ioc" | "day";
}
async function alpacaPlaceOrder(_ctx: ProgramContext, input: AlpacaOrderInput) {
	if (!input || !input.symbol || !input.side || !input.qty) {
		throw new Error("alpaca_place_order: requires {symbol, side, qty}");
	}
	const body = {
		symbol: input.symbol,
		qty: String(input.qty),
		side: input.side,
		type: input.type ?? "market",
		time_in_force: input.time_in_force ?? "gtc",
		...(input.limit_price ? { limit_price: String(input.limit_price) } : {}),
	};
	const url = `${ALPACA_PAPER_BASE}/orders`;
	const res = await fetch(url, {
		method: "POST",
		headers: { ...alpacaHeaders(), "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`alpaca_place_order: ${res.status} ${await res.text()}`);
	return await res.json();
}

// ── Hyperliquid (public read endpoints; trading deferred) ──────

async function hyperliquidPost(body: Record<string, unknown>) {
	const res = await fetch(`${HYPERLIQUID_API}/info`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Accept": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`hyperliquid: ${res.status} ${await res.text()}`);
	return await res.json();
}

interface HyperliquidPriceInput { coin?: string }
async function hyperliquidPrice(_ctx: ProgramContext, input: HyperliquidPriceInput = {}) {
	const coin = (input.coin ?? "BTC").toUpperCase();
	// `allMids` returns { "BTC": "62300.5", ... } — single round-trip
	// for all coins. Cheap public endpoint, good default.
	const mids = await hyperliquidPost({ type: "allMids" }) as Record<string, string>;
	const mid = mids[coin];
	if (!mid) return { coin, error: "coin not in allMids", available_coins_count: Object.keys(mids).length };
	return { coin, mid_price: Number(mid), source: "hyperliquid:allMids" };
}

interface HyperliquidBookInput { coin?: string; depth?: number }
async function hyperliquidOrderbook(_ctx: ProgramContext, input: HyperliquidBookInput = {}) {
	const coin = (input.coin ?? "BTC").toUpperCase();
	const depth = input.depth ?? 5;
	const book = await hyperliquidPost({ type: "l2Book", coin }) as { coin: string; levels: Array<Array<{ px: string; sz: string; n: number }>> };
	// `levels` is [bids, asks] (highest bid + lowest ask first).
	const [bids = [], asks = []] = book.levels ?? [];
	return {
		coin,
		bids: bids.slice(0, depth).map((b) => ({ price: Number(b.px), size: Number(b.sz), orders: b.n })),
		asks: asks.slice(0, depth).map((a) => ({ price: Number(a.px), size: Number(a.sz), orders: a.n })),
	};
}

interface HyperliquidAccountInput { wallet?: string }
async function hyperliquidAccount(_ctx: ProgramContext, input: HyperliquidAccountInput = {}) {
	const wallet = (input.wallet ?? process.env.HYPERLIQUID_WALLET ?? "").toLowerCase();
	if (!wallet) throw new Error("hyperliquid_account: pass {wallet} or set HYPERLIQUID_WALLET in env");
	const user = wallet.startsWith("0x") ? wallet : `0x${wallet}`;
	const state = await hyperliquidPost({ type: "clearinghouseState", user });
	return state;
}

// ── CLI handler ────────────────────────────────────────────────

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const hasAlpaca = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
		const hasHyperliquid = !!process.env.HYPERLIQUID_WALLET;
		print(bold("  btc-tools"));
		print(dim(`    alpaca:      ${hasAlpaca ? green("creds present") : red("MISSING — set ALPACA_API_KEY / ALPACA_SECRET_KEY")}`));
		print(dim(`    hyperliquid: ${hasHyperliquid ? green("wallet present") : red("MISSING — set HYPERLIQUID_WALLET")}`));
		return;
	}
	print([
		bold("  btc-tools") + dim(" — Alpaca + Hyperliquid actions for the BTC agent"),
		`    ${cyan("/btc-tools status")}     show credential availability`,
		dim("    Tools are invoked via the BTC agent's registered tool catalog,"),
		dim("    not via this CLI. See `npm run wire-btc-tools` (TODO) or call"),
		dim("    /agent registerTool by hand."),
	].join("\n"));
};

// ── Actor ──────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		alpacaBTCPrice:        async (ctx, input) => alpacaBTCPrice(ctx, input as AlpacaPriceInput),
		alpacaAccount:         async (ctx, input) => alpacaAccount(ctx, input as AlpacaAccountInput),
		alpacaPositions:       async (ctx, input) => alpacaPositions(ctx, input as AlpacaPositionsInput),
		alpacaPlaceOrder:      async (ctx, input) => alpacaPlaceOrder(ctx, input as AlpacaOrderInput),
		hyperliquidPrice:      async (ctx, input) => hyperliquidPrice(ctx, input as HyperliquidPriceInput),
		hyperliquidOrderbook:  async (ctx, input) => hyperliquidOrderbook(ctx, input as HyperliquidBookInput),
		hyperliquidAccount:    async (ctx, input) => hyperliquidAccount(ctx, input as HyperliquidAccountInput),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
