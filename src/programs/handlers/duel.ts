// duel — pit two asset agents against each other in a 24-hour prediction.
//
// Each duel:
//   1. start({agent_a_id, agent_b_id, [horizon_ms=86_400_000]})
//      → reads each agent's "primary symbol" by walking its tools and
//        finding the bound_args on alpaca_price (or hl_price as fallback).
//      → fetches the starting USD price for each side from /alpaca.
//      → asks each agent in parallel: "You're in a duel against {other}.
//        Make your case for why YOUR asset wins over the next 24h." Each
//        agent uses its own tools to form a view.
//      → parses a final-line PREDICTION + CONFIDENCE from each reply.
//      → stores the duel in /duel's own persisted state, keyed by duel_id.
//
//   2. resolve(duel_id)
//      → fetches current prices, computes % return for each side, declares
//        the winner (or "tie" if within EPS). Marks the duel resolved.
//      → safe to call early or late; idempotent once resolved.
//
//   3. get(duel_id), list()
//      → reads.
//
// The duel does NOT auto-resolve — by design, the caller (or a scheduled
// /remind, in future) triggers `resolve`. Lets the user inspect the
// pending duel for the full 24h and decide when to settle.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { randomUUID } from "node:crypto";

const PERSISTED_STATE_FIELD = "persisted_state";
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const TIE_EPS = 0.0005;  // 0.05% — anything inside this is a tie

// ── Types ───────────────────────────────────────────────────────

interface DuelParticipant {
	agent_id: string;
	agent_name: string;
	alpaca_symbol: string;          // e.g. "BTC/USD"
	hyperliquid_coin: string;       // e.g. "BTC"
	start_price_usd: number;
	prediction: string;             // free-form agent reply
	parsed_call?: "yours" | "theirs" | "tie" | "unknown";
	parsed_confidence?: "low" | "medium" | "high" | "unknown";
	final_price_usd?: number;
	pct_return?: number;            // (final - start) / start
}

interface Duel {
	id: string;
	started_at: number;
	resolves_at: number;
	status: "waiting" | "resolved" | "errored";
	a: DuelParticipant;
	b: DuelParticipant;
	winner?: "a" | "b" | "tie";
	error?: string;
}

interface PersistedDuelState {
	duels: Record<string, Duel>;
}

// ── Persistence (same shape as /directory) ──────────────────────

function snapshotState(state: Record<string, any>): string {
	return JSON.stringify({ duels: state.duels ?? {} });
}
async function restoreState(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedDuelState;
		if (parsed.duels) state.duels = parsed.duels;
		state._lastPersistedSnapshot = snapshotState(state);
	} catch (err: any) {
		ctx.print?.(dim(`  [duel] restore failed: ${err?.message ?? String(err)}`));
	}
}
async function persistIfChanged(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	const snap = snapshotState(state);
	if (state._lastPersistedSnapshot === snap) return;
	try {
		const actor = ctx.objectActor(ctx.programId) as any;
		if (typeof actor?.setField !== "function") return;
		await actor.setField(PERSISTED_STATE_FIELD, JSON.stringify(ctx.stringVal(snap)));
		state._lastPersistedSnapshot = snap;
	} catch (err: any) {
		ctx.print?.(dim(`  [duel] persist failed: ${err?.message ?? String(err)}`));
	}
}

// ── Helpers ─────────────────────────────────────────────────────

/** Read an agent's tool catalog and find its primary alpaca_symbol +
 *  hyperliquid_coin via the bound_args on its alpaca_price / hl_price
 *  tools. Falls back to agent.name (e.g. "BTC") if no bound args set. */
async function deriveAssetForAgent(ctx: ProgramContext, agentId: string): Promise<{ name: string; alpaca_symbol: string; hyperliquid_coin: string }> {
	const obj = await (ctx.store as any).get(agentId);
	if (!obj || obj.deleted) throw new Error(`duel: agent ${agentId} not found or deleted`);
	const fields = obj.fields ?? {};
	const name = fields.name?.stringValue ?? "(unnamed)";
	const tools = fields.tools?.mapValue?.entries ?? {};
	let alpacaSymbol = "";
	let hlCoin = "";
	for (const [toolName, raw] of Object.entries(tools)) {
		const entries = (raw as any)?.mapValue?.entries ?? {};
		const boundStr = entries.bound_args?.stringValue;
		if (!boundStr) continue;
		let bound: Record<string, unknown> = {};
		try { bound = JSON.parse(boundStr); } catch { continue; }
		if (!alpacaSymbol && typeof bound.symbol === "string") alpacaSymbol = bound.symbol;
		if (!hlCoin && typeof bound.coin === "string") hlCoin = bound.coin;
		if (alpacaSymbol && hlCoin) break;
		void toolName;
	}
	if (!alpacaSymbol) alpacaSymbol = `${name.toUpperCase()}/USD`;
	if (!hlCoin) hlCoin = name.toUpperCase();
	return { name, alpaca_symbol: alpacaSymbol, hyperliquid_coin: hlCoin };
}

/** Fetch the current spot price for an asset via /alpaca. Returns the
 *  Alpaca latest-bar close — the most authoritative "now" price we can
 *  cite without subscribing to a stream. */
async function fetchPrice(ctx: ProgramContext, symbol: string): Promise<number> {
	const r = await ctx.dispatchProgram("/alpaca", "getPrice", [{ symbol }]) as { price_usd?: number };
	if (typeof r?.price_usd !== "number") throw new Error(`duel: /alpaca getPrice returned no price_usd for ${symbol}: ${JSON.stringify(r)}`);
	return r.price_usd;
}

/** Parse the last few lines of an agent reply for PREDICTION / CONFIDENCE
 *  markers. Tolerant — accepts either "yours/theirs/tie" or the asset
 *  name itself. */
function parsePrediction(reply: string, yoursName: string, theirsName: string): { call: "yours"|"theirs"|"tie"|"unknown"; confidence: "low"|"medium"|"high"|"unknown" } {
	const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	let call: "yours"|"theirs"|"tie"|"unknown" = "unknown";
	let confidence: "low"|"medium"|"high"|"unknown" = "unknown";
	const Y = yoursName.toLowerCase();
	const T = theirsName.toLowerCase();
	for (const line of lines.slice(-6)) {
		const m1 = /^PREDICTION:\s*(.+)$/i.exec(line);
		if (m1) {
			const v = m1[1].trim().toLowerCase();
			if (v === "yours" || v === Y) call = "yours";
			else if (v === "theirs" || v === T) call = "theirs";
			else if (v.startsWith("tie") || v === "even" || v === "flat") call = "tie";
		}
		const m2 = /^CONFIDENCE:\s*(low|medium|high)/i.exec(line);
		if (m2) confidence = m2[1].toLowerCase() as "low"|"medium"|"high";
	}
	return { call, confidence };
}

function buildDuelPrompt(p: { yours: { name: string; symbol: string; price: number }; theirs: { name: string; symbol: string; price: number }; horizon_h: number }): string {
	return `You are in a ${p.horizon_h}-hour prediction duel.

Your asset:      ${p.yours.name} (${p.yours.symbol})
Opponent's asset: ${p.theirs.name} (${p.theirs.symbol})

Starting prices (just fetched):
  ${p.yours.name}:  $${p.yours.price.toFixed(2)}
  ${p.theirs.name}: $${p.theirs.price.toFixed(2)}

Question: which asset will deliver the higher PERCENT return over the next ${p.horizon_h} hours?

Make your case. Use your market-data tools to gather supporting evidence (recent bars, orderbook, Hyperliquid perp data, any signal you trust). Be specific and cite numbers — start prices, recent bars, your reasoning. Be honest about uncertainty.

End your reply with EXACTLY these two lines, on their own, as the last two lines of your message:

PREDICTION: <yours|theirs|tie>
CONFIDENCE: <low|medium|high>`;
}

// ── Actions ─────────────────────────────────────────────────────

interface StartInput { agent_a_id: string; agent_b_id: string; horizon_ms?: number }

async function doStart(ctx: ProgramContext, input: StartInput): Promise<Duel> {
	if (!input?.agent_a_id || !input?.agent_b_id) throw new Error("duel start: agent_a_id and agent_b_id required");
	if (input.agent_a_id === input.agent_b_id) throw new Error("duel start: agents must differ");
	const horizon = input.horizon_ms ?? DEFAULT_HORIZON_MS;

	const aAsset = await deriveAssetForAgent(ctx, input.agent_a_id);
	const bAsset = await deriveAssetForAgent(ctx, input.agent_b_id);
	const [aPrice, bPrice] = await Promise.all([
		fetchPrice(ctx, aAsset.alpaca_symbol),
		fetchPrice(ctx, bAsset.alpaca_symbol),
	]);

	const startedAt = Date.now();
	const horizonH = Math.round(horizon / 3_600_000);
	const promptA = buildDuelPrompt({
		yours:  { name: aAsset.name, symbol: aAsset.alpaca_symbol, price: aPrice },
		theirs: { name: bAsset.name, symbol: bAsset.alpaca_symbol, price: bPrice },
		horizon_h: horizonH,
	});
	const promptB = buildDuelPrompt({
		yours:  { name: bAsset.name, symbol: bAsset.alpaca_symbol, price: bPrice },
		theirs: { name: aAsset.name, symbol: aAsset.alpaca_symbol, price: aPrice },
		horizon_h: horizonH,
	});

	// Run both agents in parallel. Each invocation runs the agent's full
	// LLM loop including tool calls; this can take a while.
	const [aReply, bReply] = await Promise.all([
		ctx.dispatchProgram("/agent", "ask", [input.agent_a_id, promptA, { followUp: "none" }]) as Promise<{ finalText?: string }>,
		ctx.dispatchProgram("/agent", "ask", [input.agent_b_id, promptB, { followUp: "none" }]) as Promise<{ finalText?: string }>,
	]);
	const aText = aReply?.finalText ?? "";
	const bText = bReply?.finalText ?? "";
	const aParsed = parsePrediction(aText, aAsset.name, bAsset.name);
	const bParsed = parsePrediction(bText, bAsset.name, aAsset.name);

	const duel: Duel = {
		id: randomUUID().replace(/-/g, "").slice(0, 16),
		started_at: startedAt,
		resolves_at: startedAt + horizon,
		status: "waiting",
		a: {
			agent_id: input.agent_a_id,
			agent_name: aAsset.name,
			alpaca_symbol: aAsset.alpaca_symbol,
			hyperliquid_coin: aAsset.hyperliquid_coin,
			start_price_usd: aPrice,
			prediction: aText,
			parsed_call: aParsed.call,
			parsed_confidence: aParsed.confidence,
		},
		b: {
			agent_id: input.agent_b_id,
			agent_name: bAsset.name,
			alpaca_symbol: bAsset.alpaca_symbol,
			hyperliquid_coin: bAsset.hyperliquid_coin,
			start_price_usd: bPrice,
			prediction: bText,
			parsed_call: bParsed.call,
			parsed_confidence: bParsed.confidence,
		},
	};

	const state = ctx.state;
	state.duels = state.duels ?? {};
	state.duels[duel.id] = duel;
	await persistIfChanged(state, ctx);
	return duel;
}

interface ResolveInput { id: string }

async function doResolve(ctx: ProgramContext, input: ResolveInput): Promise<Duel> {
	const id = input?.id;
	if (!id) throw new Error("duel resolve: id required");
	const state = ctx.state;
	const duel = (state.duels ?? {})[id] as Duel | undefined;
	if (!duel) throw new Error(`duel resolve: unknown id ${id}`);
	if (duel.status === "resolved") return duel;     // idempotent

	const [aFinal, bFinal] = await Promise.all([
		fetchPrice(ctx, duel.a.alpaca_symbol),
		fetchPrice(ctx, duel.b.alpaca_symbol),
	]);
	const aReturn = (aFinal - duel.a.start_price_usd) / duel.a.start_price_usd;
	const bReturn = (bFinal - duel.b.start_price_usd) / duel.b.start_price_usd;
	duel.a.final_price_usd = aFinal;
	duel.b.final_price_usd = bFinal;
	duel.a.pct_return = aReturn;
	duel.b.pct_return = bReturn;
	const diff = aReturn - bReturn;
	duel.winner = Math.abs(diff) < TIE_EPS ? "tie" : (diff > 0 ? "a" : "b");
	duel.status = "resolved";
	state.duels[id] = duel;
	await persistIfChanged(state, ctx);
	return duel;
}

async function doGet(ctx: ProgramContext, input: { id: string }): Promise<Duel | null> {
	return (ctx.state.duels ?? {})[input?.id] ?? null;
}

async function doList(ctx: ProgramContext): Promise<Duel[]> {
	return Object.values((ctx.state.duels ?? {}) as Record<string, Duel>)
		.sort((a, b) => b.started_at - a.started_at);
}

// ── CLI handler ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "list") {
		const all = await doList(ctx);
		if (all.length === 0) { print(dim("(no duels yet)")); return; }
		for (const d of all) {
			const age = Math.round((Date.now() - d.started_at) / 60_000);
			const status = d.status === "resolved" ? green(`resolved ${d.winner}`) : yellow("waiting");
			print(`  ${d.id}  ${d.a.agent_name} vs ${d.b.agent_name}  ${age}m ago  ${status}`);
		}
		return;
	}
	if (cmd === "get") {
		const d = await doGet(ctx, { id: args[0] });
		if (!d) { print(red("not found")); return; }
		print(JSON.stringify(d, null, 2));
		return;
	}
	if (cmd === "resolve") {
		const id = args[0];
		if (!id) { print(red("Usage: /duel resolve <duel-id>")); return; }
		try {
			const d = await doResolve(ctx, { id });
			print(green(`resolved ${id} — winner: ${d.winner}`));
		} catch (err: any) { print(red(`Error: ${err?.message ?? String(err)}`)); }
		return;
	}
	print([
		bold("  duel") + dim(" — pit two asset agents against each other in a prediction"),
		`    ${cyan("/duel list")}                              all duels`,
		`    ${cyan("/duel get")} ${dim("<duel-id>")}                    full duel state (JSON)`,
		`    ${cyan("/duel resolve")} ${dim("<duel-id>")}                check current prices, declare winner`,
		dim("    Starting a duel goes through the typed action `/duel start {agent_a_id, agent_b_id}`."),
	].join("\n"));
};

// ── Actor ──────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ duels: {} }),
	onCreate: async (ctx) => { await restoreState(ctx.state, ctx); },
	actions: {
		start:   async (ctx, input) => doStart(ctx, input as StartInput),
		resolve: async (ctx, input) => doResolve(ctx, input as ResolveInput),
		get:     async (ctx, input) => doGet(ctx, input as { id: string }),
		list:    async (ctx) => doList(ctx),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
