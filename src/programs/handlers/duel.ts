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
	final_price_usd?: number;
	pct_return?: number;            // (final - start) / start, set at resolve
}

interface JudgeReply {
	agent_id: string;
	agent_name: string;             // name of the AGENT, not the asset
	reasoning: string;               // free-form reply
	parsed_vote?: string;            // an asset name ("BTC" / "ETH") or "tie" or "unknown"
	parsed_confidence?: "low" | "medium" | "high" | "unknown";
}

interface Duel {
	id: string;
	started_at: number;
	resolves_at: number;
	status: "waiting" | "resolved" | "errored";
	a: DuelParticipant;
	b: DuelParticipant;
	// Both agents vote NEUTRALLY (no bias toward their own asset). The
	// agent_id in each judge entry identifies WHICH agent cast the vote;
	// the .parsed_vote field is the ASSET NAME they voted for.
	judges: JudgeReply[];
	// Predicted winner from agreement: a or b if both judges voted the
	// same asset, "tie" otherwise (including any disagreement or any
	// judge voting "tie"). Computed at start time.
	predicted_winner?: "a" | "b" | "tie";
	// Factual winner set at /duel resolve based on actual 24h % return.
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

/** Parse VOTE + CONFIDENCE tail lines from a neutral-judge reply.
 *  Tolerant — accepts the asset name in any casing, "tie", "even",
 *  "flat", or "a"/"b" (legacy). Returns { vote: assetName | "tie" |
 *  "unknown" }. */
function parseJudgeVote(reply: string, assetA: string, assetB: string): { vote: string; confidence: "low"|"medium"|"high"|"unknown" } {
	const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const A = assetA.toLowerCase();
	const B = assetB.toLowerCase();
	let vote = "unknown";
	let confidence: "low"|"medium"|"high"|"unknown" = "unknown";
	for (const line of lines.slice(-8)) {
		const m1 = /^VOTE:\s*(.+)$/i.exec(line);
		if (m1) {
			const v = m1[1].trim().toLowerCase();
			if (v === A || v === "a") vote = assetA;
			else if (v === B || v === "b") vote = assetB;
			else if (v.startsWith("tie") || v === "even" || v === "flat") vote = "tie";
		}
		const m2 = /^CONFIDENCE:\s*(low|medium|high)/i.exec(line);
		if (m2) confidence = m2[1].toLowerCase() as "low"|"medium"|"high";
	}
	return { vote, confidence };
}

/** Pre-fetch all market data both judges will need. Hits Alpaca for
 *  bars and Hyperliquid for mid + L2 book in parallel. Anything that
 *  errors becomes a `null` so the prompt can still render. */
async function gatherEvidence(ctx: ProgramContext, symbol: string, coin: string) {
	const [barsRaw, midRaw, bookRaw] = await Promise.all([
		ctx.dispatchProgram("/alpaca", "getBars", [{ symbol, timeframe: "1Hour", limit: 6 }]).catch(() => null) as Promise<any>,
		ctx.dispatchProgram("/hyperliquid", "getPrice", [{ coin }]).catch(() => null) as Promise<any>,
		ctx.dispatchProgram("/hyperliquid", "getOrderbook", [{ coin, depth: 5 }]).catch(() => null) as Promise<any>,
	]);
	const bars = (barsRaw as any)?.bars?.[symbol];
	const hl_mid = (midRaw as any)?.mid_price;
	const book = bookRaw as { bids?: Array<{ price: number; size: number }>; asks?: Array<{ price: number; size: number }> } | null;
	return {
		bars: Array.isArray(bars) ? bars.slice(-6).map((b: any) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) : null,
		hl_mid: typeof hl_mid === "number" ? hl_mid : null,
		book_bids: book?.bids?.slice(0, 5) ?? null,
		book_asks: book?.asks?.slice(0, 5) ?? null,
	};
}

/** Neutral-judge prompt: BOTH agents get the SAME prompt, with the
 *  same market evidence for both assets. They must vote impartially
 *  (the prompt is explicit about ignoring any in-character bias they
 *  might have toward their associated asset). */
function buildJudgePrompt(p: {
	a: { name: string; symbol: string; start_price: number; evidence: Awaited<ReturnType<typeof gatherEvidence>> };
	b: { name: string; symbol: string; start_price: number; evidence: Awaited<ReturnType<typeof gatherEvidence>> };
	horizon_h: number;
}): string {
	const dump = (e: Awaited<ReturnType<typeof gatherEvidence>>) => JSON.stringify(e, null, 2);
	return `You are a NEUTRAL JUDGE.

Two assets are being compared. Vote for whichever you think will deliver the higher PERCENT return over the next ${p.horizon_h} hours.

IMPORTANT — vote impartially. Do NOT favour an asset because of any persona, scope, or focus area you may have. Both assets are candidates. You are looking at the same evidence and making one call. Vote "tie" if you genuinely think they'll be within ~0.5% of each other.

ASSET A: ${p.a.name}  (${p.a.symbol})
  Starting price (Alpaca):   $${p.a.start_price.toFixed(2)}
  Evidence:
${dump(p.a.evidence)}

ASSET B: ${p.b.name}  (${p.b.symbol})
  Starting price (Alpaca):   $${p.b.start_price.toFixed(2)}
  Evidence:
${dump(p.b.evidence)}

Briefly state your reasoning, then end your reply with EXACTLY these two lines (case-insensitive, but the literal labels), as the LAST two lines of your message:

VOTE: <${p.a.name}|${p.b.name}|tie>
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

	// Snapshot both assets in parallel: starting price + evidence
	// (recent bars + Hyperliquid mid + L2 book). The same evidence
	// dump is shown to both judges below.
	const [aPrice, bPrice, aEvidence, bEvidence] = await Promise.all([
		fetchPrice(ctx, aAsset.alpaca_symbol),
		fetchPrice(ctx, bAsset.alpaca_symbol),
		gatherEvidence(ctx, aAsset.alpaca_symbol, aAsset.hyperliquid_coin),
		gatherEvidence(ctx, bAsset.alpaca_symbol, bAsset.hyperliquid_coin),
	]);

	const startedAt = Date.now();
	const horizonH = Math.round(horizon / 3_600_000);
	// SAME prompt for both judges — they each receive identical
	// evidence and must vote impartially.
	const prompt = buildJudgePrompt({
		a: { name: aAsset.name, symbol: aAsset.alpaca_symbol, start_price: aPrice, evidence: aEvidence },
		b: { name: bAsset.name, symbol: bAsset.alpaca_symbol, start_price: bPrice, evidence: bEvidence },
		horizon_h: horizonH,
	});

	// Run both agents in parallel.
	const [aReply, bReply] = await Promise.all([
		ctx.dispatchProgram("/agent", "ask", [input.agent_a_id, prompt, { followUp: "none" }]) as Promise<{ finalText?: string }>,
		ctx.dispatchProgram("/agent", "ask", [input.agent_b_id, prompt, { followUp: "none" }]) as Promise<{ finalText?: string }>,
	]);
	const aText = aReply?.finalText ?? "";
	const bText = bReply?.finalText ?? "";
	const aParsed = parseJudgeVote(aText, aAsset.name, bAsset.name);
	const bParsed = parseJudgeVote(bText, aAsset.name, bAsset.name);

	// Consensus rule:
	//   - both judges vote same asset → that asset wins (a or b)
	//   - both vote tie → tie
	//   - any disagreement (one votes A, other votes B; or one votes
	//     tie, the other an asset; or any unknown) → tie
	let predicted: "a" | "b" | "tie" = "tie";
	if (aParsed.vote === bParsed.vote && aParsed.vote !== "unknown") {
		if (aParsed.vote === aAsset.name)      predicted = "a";
		else if (aParsed.vote === bAsset.name) predicted = "b";
		else                                    predicted = "tie";
	}

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
		},
		b: {
			agent_id: input.agent_b_id,
			agent_name: bAsset.name,
			alpaca_symbol: bAsset.alpaca_symbol,
			hyperliquid_coin: bAsset.hyperliquid_coin,
			start_price_usd: bPrice,
		},
		judges: [
			{ agent_id: input.agent_a_id, agent_name: aAsset.name, reasoning: aText, parsed_vote: aParsed.vote, parsed_confidence: aParsed.confidence },
			{ agent_id: input.agent_b_id, agent_name: bAsset.name, reasoning: bText, parsed_vote: bParsed.vote, parsed_confidence: bParsed.confidence },
		],
		predicted_winner: predicted,
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
