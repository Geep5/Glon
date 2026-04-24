// Discord — I/O bridge between Gracie (or any Glon agent) and Discord.
//
// Runs as a Glon program with a 3-second tick. Each tick:
//   1. Loads peers that have `discord_id` set via /peer.list
//   2. Opens/caches a DM channel per peer
//   3. Polls each DM channel for new messages since its watermark
//   4. Dispatches each inbound to /gracie.ingest(source="discord", peer_id, text)
//   5. Sends Gracie's final reply back as Discord messages (split at 2000)
//
// Actions exposed to other programs (Gracie calls these as tools):
//   - send(peerId, text)       — DM a peer by peer id
//   - sendChannel(channelId, text) — post to a specific channel
//   - typing(peerId)           — typing indicator while Gracie thinks
//
// Credentials: DISCORD_BOT_TOKEN env var only. Never persisted to the DAG.
// State (bot user id, channel cache, watermarks) lives in the actor's
// in-memory state. On restart we re-fetch bot user and set watermarks
// from the newest inbound per channel, skipping historical backfill.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_POLL_MS = 3000;
const MESSAGE_MAX_LEN = 2000;

// ── Types ────────────────────────────────────────────────────────

interface PeerSnapshot {
	id: string;
	display_name: string;
	kind: string;
	trust_level: string;
	discord_id?: string;
}

interface DiscordMessage {
	id: string;
	author: { id: string; username?: string; global_name?: string };
	content: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function token(): string {
	const t = process.env.DISCORD_BOT_TOKEN;
	if (!t) throw new Error("DISCORD_BOT_TOKEN not set");
	return t;
}

/** Discord REST helper. Respects 429 with Retry-After. */
async function discord(method: string, path: string, body?: unknown): Promise<any> {
	const testFetch = (globalThis as any).__DISCORD_FETCH as
		| undefined
		| ((req: { method: string; path: string; body: unknown }) => Promise<any>);
	if (testFetch) {
		return testFetch({ method, path, body });
	}

	const headers: Record<string, string> = {
		"Authorization": `Bot ${token()}`,
		"User-Agent": "Glon/Gracie (+https://github.com/Geep5/Glon)",
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(`${DISCORD_API}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (res.status === 429) {
		const raw = await res.text();
		let retryAfter = 1;
		try { retryAfter = JSON.parse(raw).retry_after ?? 1; } catch { /* ignore */ }
		throw new Error(`Discord 429 — retry after ${retryAfter}s`);
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
	}
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

/** Split text at newline boundaries into chunks ≤ maxLen. */
export function splitMessage(text: string, maxLen = MESSAGE_MAX_LEN): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxLen) {
		let cut = remaining.lastIndexOf("\n", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).replace(/^\n+/, "");
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

async function getBotUserId(state: Record<string, any>): Promise<string> {
	if (state.botUserId) return state.botUserId;
	const me = await discord("GET", "/users/@me");
	if (!me?.id) throw new Error("failed to resolve bot user id");
	state.botUserId = me.id as string;
	return state.botUserId;
}

/** Get (or open) the DM channel with a peer. Result is cached in state. */
async function getDmChannel(peer: PeerSnapshot, state: Record<string, any>): Promise<string> {
	if (!peer.discord_id) throw new Error(`peer ${peer.id} has no discord_id set`);
	state.dmChannelByPeer = state.dmChannelByPeer ?? {};
	if (state.dmChannelByPeer[peer.id]) return state.dmChannelByPeer[peer.id];
	const ch = await discord("POST", "/users/@me/channels", { recipient_id: peer.discord_id });
	if (!ch?.id) throw new Error(`failed to open DM channel with ${peer.discord_id}`);
	state.dmChannelByPeer[peer.id] = ch.id as string;
	return ch.id as string;
}

async function postMessage(channelId: string, text: string): Promise<string[]> {
	const parts = splitMessage(text);
	const ids: string[] = [];
	for (const part of parts) {
		const msg = await discord("POST", `/channels/${channelId}/messages`, { content: part });
		if (msg?.id) ids.push(msg.id as string);
	}
	return ids;
}

async function fetchPeersWithDiscord(ctx: ProgramContext): Promise<PeerSnapshot[]> {
	const all = await ctx.dispatchProgram("/peer", "list", []) as PeerSnapshot[];
	return all.filter((p) => !!p.discord_id);
}

// ── Core: sending ────────────────────────────────────────────────

async function doSend(peerId: string, text: string, state: Record<string, any>, ctx: ProgramContext): Promise<{ channel_id: string; message_ids: string[] }> {
	const peer = await ctx.dispatchProgram("/peer", "get", [peerId]) as PeerSnapshot | null;
	if (!peer) throw new Error(`unknown peer: ${peerId}`);
	if (!peer.discord_id) throw new Error(`peer ${peer.display_name} has no discord_id`);
	const channelId = await getDmChannel(peer, state);
	const ids = await postMessage(channelId, text);
	return { channel_id: channelId, message_ids: ids };
}

async function doSendChannel(channelId: string, text: string): Promise<{ channel_id: string; message_ids: string[] }> {
	const ids = await postMessage(channelId, text);
	return { channel_id: channelId, message_ids: ids };
}

async function doTyping(peerId: string, state: Record<string, any>, ctx: ProgramContext): Promise<{ ok: boolean }> {
	const peer = await ctx.dispatchProgram("/peer", "get", [peerId]) as PeerSnapshot | null;
	if (!peer) throw new Error(`unknown peer: ${peerId}`);
	if (!peer.discord_id) throw new Error(`peer ${peer.display_name} has no discord_id`);
	const channelId = await getDmChannel(peer, state);
	await discord("POST", `/channels/${channelId}/typing`);
	return { ok: true };
}

// ── Core: polling ────────────────────────────────────────────────

/** Discord snowflake epoch — all snowflake timestamps are offsets from this. */
const DISCORD_EPOCH_MS = 1420070400000;

/**
 * Window for processing "recent" messages on the first poll of a channel.
 *
 * Rationale: the old behavior was to silently absorb the newest message into
 * the watermark on first tick, which meant a user's very first DM to the bot
 * got dropped — a common first-time setup trap. We now process messages whose
 * snowflake timestamp is within this window so an onboarding DM is answered.
 * Older history is still skipped so a long-offline bot does not flood on boot.
 */
const FIRST_POLL_RECENCY_MS = 15 * 60 * 1000;

/** Extract the Unix ms timestamp encoded in a Discord snowflake id. */
export function snowflakeTimestampMs(id: string): number {
	return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

async function pollPeer(peer: PeerSnapshot, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!peer.discord_id) return 0;
	state.watermarks = state.watermarks ?? {};

	const channelId = await getDmChannel(peer, state);
	const watermark = state.watermarks[channelId] as string | undefined;
	const isFirstPoll = !watermark;

	// First poll: fetch a small tail so we can honour the recency window.
	// Subsequent polls only need messages after the watermark.
	const qs = isFirstPoll ? `?limit=5` : `?limit=10&after=${watermark}`;
	const msgs = await discord("GET", `/channels/${channelId}/messages${qs}`) as DiscordMessage[] | null;
	if (!msgs || msgs.length === 0) {
		// Ensure the channel has *some* watermark so next tick uses `after`.
		if (isFirstPoll) state.watermarks[channelId] = "0";
		return 0;
	}

	const botUserId = await getBotUserId(state);
	// Discord returns newest-first; process oldest-first so the DAG sees them in order.
	const sorted = [...msgs].sort((a, b) => a.id.localeCompare(b.id));

	// On first poll, skip anything older than the recency window. This preserves the
	// "no unbounded history replay" invariant while still picking up a user's onboarding DM.
	const now = Date.now();
	const eligible = isFirstPoll
		? sorted.filter((m) => now - snowflakeTimestampMs(m.id) <= FIRST_POLL_RECENCY_MS)
		: sorted;

	// Always advance the watermark to the newest returned message, even for skipped
	// messages, so the next tick only sees genuinely new traffic.
	const newest = sorted[sorted.length - 1].id;
	if (!watermark || newest > watermark) state.watermarks[channelId] = newest;

	let processed = 0;
	for (const m of eligible) {
		const authorId = m.author?.id;
		if (!authorId || authorId === botUserId) continue;
		const content = (m.content ?? "").trim();
		if (!content) continue;

		processed++;
		try {
			// Fire typing while we think.
			discord("POST", `/channels/${channelId}/typing`).catch(() => { /* non-critical */ });

			const result = await ctx.dispatchProgram("/gracie", "ingest", ["discord", peer.id, content]) as {
				finalText: string;
			};
			if (result?.finalText) {
				await postMessage(channelId, result.finalText);
			}
		} catch (err: any) {
			// Don't let one bad message poison the rest of the poll.
			try {
				await postMessage(channelId, `[error: ${err?.message ?? String(err)}]`);
			} catch { /* best-effort */ }
		}
	}
	return processed;
}

async function runPoll(state: Record<string, any>, ctx: ProgramContext): Promise<{ peers: number; processed: number }> {
	const peers = await fetchPeersWithDiscord(ctx);
	let processed = 0;
	for (const peer of peers) {
		try {
			processed += await pollPeer(peer, state, ctx);
		} catch (err: any) {
			// Log but continue with other peers.
			ctx.print(dim(`  [discord] poll error for ${peer.display_name}: ${err?.message ?? String(err)}`));
		}
	}
	return { peers: peers.length, processed };
}

// ── Core: Gateway (presence / "online" status) ─────────────────
//
// Discord shows a bot as online only while it holds a live Gateway
// WebSocket. REST alone can't do it. We maintain a single outbound WSS
// client from the discord programActor, keep it warm with heartbeats, and
// reconnect with jittered exponential backoff on any drop.
//
// Intents are 0 — we don't subscribe to any events. REST polling already
// handles inbound DMs. This keeps the bot presence-only, so no privileged
// intents are required on the Discord developer dashboard.
//
// The WS client lives in the daemon process (scripts/daemon.ts). When the
// daemon dies the connection dies with it; onCreate/onTick re-open it when
// the daemon is restarted.

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GATEWAY_PRESENCE_ACTIVITY_NAME = "/gracie say";
const GATEWAY_PRESENCE_ACTIVITY_TYPE = 2; // 2 = Listening to …

// Gateway opcodes — see https://discord.com/developers/docs/events/gateway-events
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const GATEWAY_MAX_BACKOFF_MS = 30_000;
const GATEWAY_BASE_BACKOFF_MS = 1_000;

/** Close codes that indicate we should not retry — configuration is wrong. */
const GATEWAY_FATAL_CLOSE_CODES = new Set([
	4004, // authentication failed (bad token)
	4010, // invalid shard
	4011, // sharding required
	4012, // invalid API version
	4013, // invalid intents
	4014, // disallowed intents (privileged intent not enabled in dev portal)
]);

/**
 * Minimal WebSocket shape we use. We accept `globalThis.WebSocket` (Node 22+)
 * or a test-injected fake via `globalThis.__DISCORD_GATEWAY_WS_CTOR`.
 */
interface GatewayWS {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	// Discord sends everything as text frames; we set these directly on the
	// instance so test fakes don't need an EventTarget implementation.
	onopen: ((ev?: any) => void) | null;
	onmessage: ((ev: { data: string }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: ((ev: any) => void) | null;
}

type GatewayWSCtor = new (url: string) => GatewayWS;

function gatewayWSCtor(): GatewayWSCtor {
	const injected = (globalThis as any).__DISCORD_GATEWAY_WS_CTOR as GatewayWSCtor | undefined;
	if (injected) return injected;
	return WebSocket as unknown as GatewayWSCtor;
}

/** Build the IDENTIFY payload. Pure — unit-testable. */
export function buildIdentifyPayload(token: string): unknown {
	return {
		op: OP_IDENTIFY,
		d: {
			token,
			intents: 0,
			properties: {
				os: process.platform,
				browser: "glon",
				device: "glon",
			},
			presence: {
				status: "online",
				since: null,
				afk: false,
				activities: [
					{ name: GATEWAY_PRESENCE_ACTIVITY_NAME, type: GATEWAY_PRESENCE_ACTIVITY_TYPE },
				],
			},
		},
	};
}

/** Jittered exponential backoff. Pure. */
export function computeReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(GATEWAY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), GATEWAY_MAX_BACKOFF_MS);
	const jitter = 0.25; // ±25%
	return Math.round(base * (1 - jitter + random() * jitter * 2));
}

/** Decide whether the next heartbeat is due. Pure. */
export function shouldSendHeartbeat(state: Record<string, any>, now: number): boolean {
	if (!state.gatewayHeartbeatMs) return false;
	if (!state.gatewayConnected) return false;
	const last = state.gatewayLastHeartbeatSentAt ?? 0;
	return now - last >= state.gatewayHeartbeatMs;
}

/**
 * Detect a "zombied" connection where we've sent heartbeats but the server
 * hasn't ack'd in over two intervals. Discord tells us to reconnect in this
 * case (https://discord.com/developers/docs/events/gateway#heartbeat-interval).
 */
export function isHeartbeatAckOverdue(state: Record<string, any>, now: number): boolean {
	if (!state.gatewayHeartbeatMs) return false;
	if (!state.gatewayConnected) return false;
	const lastSent = state.gatewayLastHeartbeatSentAt ?? 0;
	const lastAck = state.gatewayLastHeartbeatAckAt ?? 0;
	if (lastSent === 0) return false; // never sent yet
	if (lastAck >= lastSent) return false; // all ack'd
	return now - lastSent >= state.gatewayHeartbeatMs * 2;
}

function sendHeartbeat(state: Record<string, any>, ws: GatewayWS, now: number): void {
	ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: state.gatewayLastSeq ?? null }));
	state.gatewayLastHeartbeatSentAt = now;
}

interface GatewayFrame {
	op: number;
	d?: any;
	s?: number | null;
	t?: string | null;
}

/**
 * Dispatch a received Gateway frame. Returns structured actions for the caller
 * so we can unit-test the decision logic without real network or timers.
 */
export function handleGatewayFrame(state: Record<string, any>, frame: GatewayFrame, now: number): {
	sendIdentify: boolean;
	sendHeartbeat: boolean;
	reconnect: boolean;
} {
	let sendIdentify = false;
	let sendHb = false;
	let reconnect = false;

	switch (frame.op) {
		case OP_HELLO: {
			const intervalMs = Number(frame.d?.heartbeat_interval);
			if (intervalMs > 0) state.gatewayHeartbeatMs = intervalMs;
			sendIdentify = true;
			break;
		}
		case OP_HEARTBEAT: {
			// Server requested an immediate heartbeat (out-of-band).
			sendHb = true;
			break;
		}
		case OP_HEARTBEAT_ACK: {
			state.gatewayLastHeartbeatAckAt = now;
			break;
		}
		case OP_RECONNECT: {
			reconnect = true;
			break;
		}
		case OP_INVALID_SESSION: {
			// Always treat as non-resumable — we never resume sessions.
			reconnect = true;
			break;
		}
		case OP_DISPATCH: {
			if (typeof frame.s === "number") state.gatewayLastSeq = frame.s;
			if (frame.t === "READY") {
				state.gatewayIdentified = true;
				state.gatewayReconnectAttempts = 0;
				state.botUserId = frame.d?.user?.id ?? state.botUserId;
			}
			break;
		}
		default: {
			// Ignore any other opcodes (HEARTBEAT_ACK handled above, etc.).
			break;
		}
	}
	return { sendIdentify, sendHeartbeat: sendHb, reconnect };
}

/** Is this close code fatal (stop retrying)? Pure. */
export function shouldReconnectOnClose(code: number | undefined): boolean {
	if (code === undefined) return true;
	if (GATEWAY_FATAL_CLOSE_CODES.has(code)) return false;
	return true;
}

/** Close and detach an active WS connection without triggering reconnect. */
function closeGateway(state: Record<string, any>, code = 1000, reason = ""): void {
	const ws = state.gatewayWs as GatewayWS | null;
	state.gatewayConnected = false;
	state.gatewayIdentified = false;
	if (ws) {
		// Detach handlers first so the close doesn't trigger our reconnect path.
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		try { ws.close(code, reason); } catch { /* best-effort */ }
	}
	state.gatewayWs = null;
	state.gatewayHeartbeatMs = null;
}

/**
 * Open a new Gateway connection. Safe to call when a connection is already
 * open — the old one is closed first. All handlers and state updates live
 * here; tick logic drives heartbeats and reconnects.
 */
function openGateway(state: Record<string, any>, ctx: ProgramContext): void {
	if (state.gatewayFatal) return; // stopped after fatal close
	if (state.gatewayWs) closeGateway(state);
	const token = process.env.DISCORD_BOT_TOKEN;
	if (!token) return;

	let ws: GatewayWS;
	try {
		ws = new (gatewayWSCtor())(GATEWAY_URL);
	} catch (err: any) {
		ctx.print(dim(`  [discord] gateway connect failed: ${err?.message ?? String(err)}`));
		scheduleGatewayReconnect(state);
		return;
	}

	state.gatewayWs = ws;
	state.gatewayConnected = false;
	state.gatewayIdentified = false;
	state.gatewayLastHeartbeatSentAt = 0;
	state.gatewayLastHeartbeatAckAt = 0;
	state.gatewayLastSeq = null;

	ws.onopen = () => { state.gatewayConnected = true; };

	ws.onmessage = (ev: { data: string }) => {
		let frame: GatewayFrame;
		try { frame = JSON.parse(ev.data); }
		catch { return; } // ignore malformed
		const now = Date.now();
		const wasIdentified = state.gatewayIdentified;
		const actions = handleGatewayFrame(state, frame, now);
		if (!wasIdentified && state.gatewayIdentified) {
			ctx.print(green(`  [discord] gateway connected — presence online`));
		}
		if (actions.sendIdentify) {
			ws.send(JSON.stringify(buildIdentifyPayload(token)));
		}
		if (actions.sendHeartbeat) {
			sendHeartbeat(state, ws, now);
		}
		if (actions.reconnect) {
			closeGateway(state, 1000);
			scheduleGatewayReconnect(state);
		}
	};

	ws.onclose = (ev: { code: number; reason: string }) => {
		state.gatewayConnected = false;
		state.gatewayIdentified = false;
		state.gatewayWs = null;
		if (!shouldReconnectOnClose(ev.code)) {
			state.gatewayFatal = true;
			ctx.print(red(`  [discord] gateway closed fatally (code=${ev.code}): ${ev.reason || "bot will stay offline"}`));
			return;
		}
		scheduleGatewayReconnect(state);
	};

	ws.onerror = () => {
		// Errors are followed by a close — let onclose handle reconnect.
	};
}

function scheduleGatewayReconnect(state: Record<string, any>): void {
	state.gatewayReconnectAttempts = (state.gatewayReconnectAttempts ?? 0) + 1;
	state.gatewayNextReconnectAt = Date.now() + computeReconnectDelayMs(state.gatewayReconnectAttempts);
}

/**
 * Called from onTick. Keeps the connection healthy:
 *   - reconnect if disconnected and backoff elapsed
 *   - fire a heartbeat if one is due
 *   - force-reconnect if we're in a zombie state (no ack in 2×interval)
 */
function tickGateway(state: Record<string, any>, ctx: ProgramContext): void {
	if (state.gatewayFatal) return;
	if (!process.env.DISCORD_BOT_TOKEN) return;
	const now = Date.now();

	if (!state.gatewayWs) {
		if (!state.gatewayNextReconnectAt || now >= state.gatewayNextReconnectAt) {
			openGateway(state, ctx);
		}
		return;
	}

	if (isHeartbeatAckOverdue(state, now)) {
		ctx.print(dim("  [discord] gateway heartbeat ack overdue — reconnecting"));
		closeGateway(state, 4000);
		scheduleGatewayReconnect(state);
		return;
	}

	if (shouldSendHeartbeat(state, now)) {
		const ws = state.gatewayWs as GatewayWS;
		try { sendHeartbeat(state, ws, now); }
		catch { /* close handler will reconnect */ }
	}
}


// ── Handler (CLI subcommands) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;
	const state = ctx.state;

	switch (cmd) {
		// /discord status
		case "status": {
			state.watermarks = state.watermarks ?? {};
			state.dmChannelByPeer = state.dmChannelByPeer ?? {};
			const watchedCount = Object.keys(state.watermarks).length;
			const cachedCount = Object.keys(state.dmChannelByPeer).length;
			print(bold("  Discord"));
			print(dim(`  bot user id: ${state.botUserId || "(not resolved yet)"}`));
			print(dim(`  poll interval: ${state.pollMs ?? DEFAULT_POLL_MS}ms`));
			print(dim(`  DM channels cached: ${cachedCount}`));
			print(dim(`  watermarks tracked: ${watchedCount}`));
			break;
		}

		// /discord send <peerId> <text...>
		case "send": {
			const raw = args[0];
			const text = args.slice(1).join(" ");
			if (!raw || !text) { print(red("Usage: /discord send <peerId> <text...>")); break; }
			const peerId = await resolveId(raw) ?? raw;
			try {
				const r = await doSend(peerId, text, state, ctx);
				print(green(`  sent ${r.message_ids.length} message(s)`) + dim(` to channel ${r.channel_id}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /discord poll — manually trigger a poll cycle (for debugging)
		case "poll": {
			try {
				const r = await runPoll(state, ctx);
				print(dim(`  polled ${r.peers} peer(s), processed ${r.processed} message(s)`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Discord") + dim(" — inbound/outbound bridge"),
				`    ${cyan("discord status")}                          show bridge state`,
				`    ${cyan("discord send")} ${dim("<peerId> <text...>")}      send a DM`,
				`    ${cyan("discord poll")}                            trigger a poll cycle now`,
				"",
				dim("  Requires DISCORD_BOT_TOKEN env var. Peers must have discord_id set."),
				dim("  Actor polls every 3s automatically; this CLI is for diagnostics."),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + tick loop) ─────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({
		botUserId: "",
		dmChannelByPeer: {} as Record<string, string>,
		watermarks: {} as Record<string, string>,
		pollMs: DEFAULT_POLL_MS,
		tickInProgress: false,
		// Gateway (presence) state — managed by openGateway/tickGateway.
		gatewayWs: null as GatewayWS | null,
		gatewayConnected: false,
		gatewayIdentified: false,
		gatewayHeartbeatMs: null as number | null,
		gatewayLastSeq: null as number | null,
		gatewayLastHeartbeatSentAt: 0,
		gatewayLastHeartbeatAckAt: 0,
		gatewayReconnectAttempts: 0,
		gatewayNextReconnectAt: 0,
		gatewayFatal: false,
	}),

	onCreate: async (ctx: ProgramContext) => {
		// Warm up the bot user id on startup (non-fatal if it fails — tick retries).
		if (!process.env.DISCORD_BOT_TOKEN) return;
		try {
			await getBotUserId(ctx.state);
		} catch {
			// Log handled in tick loop.
		}
		// Open the Gateway connection so the bot appears online. Non-blocking:
		// the WebSocket handshake and IDENTIFY happen on their own event loop.
		openGateway(ctx.state, ctx);
	},

	onDestroy: async (ctx: ProgramContext) => {
		closeGateway(ctx.state, 1000, "daemon shutdown");
	},

	tickMs: DEFAULT_POLL_MS,

	onTick: async (ctx: ProgramContext) => {
		if (!process.env.DISCORD_BOT_TOKEN) return;
		// Gateway maintenance runs on every tick, independent of the REST
		// poll guard. A stalled REST poll should never block presence.
		try { tickGateway(ctx.state, ctx); }
		catch (err: any) { ctx.print(dim(`  [discord] gateway tick error: ${err?.message ?? String(err)}`)); }

		if (ctx.state.tickInProgress) return;
		ctx.state.tickInProgress = true;
		try {
			await runPoll(ctx.state, ctx);
		} catch (err: any) {
			// onTick errors are swallowed by runtime, but we log for diagnostics.
			ctx.print(dim(`  [discord] tick error: ${err?.message ?? String(err)}`));
		} finally {
			ctx.state.tickInProgress = false;
		}
	},

	actions: {
		/** Send a DM to a peer (by peer id). Exposed to Gracie as a tool. */
		send: async (ctx: ProgramContext, input: string | { peer_id?: string; text?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const peerId = args?.peer_id;
			const text = args?.text;
			if (!peerId || !text) throw new Error("discord.send: peer_id and text required");
			return await doSend(peerId, text, ctx.state, ctx);
		},

		/** Post to a specific channel id. */
		sendChannel: async (_ctx: ProgramContext, input: string | { channel_id?: string; text?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const channelId = args?.channel_id;
			const text = args?.text;
			if (!channelId || !text) throw new Error("discord.sendChannel: channel_id and text required");
			return await doSendChannel(channelId, text);
		},

		/** Send a typing indicator to a peer's DM channel. */
		typing: async (ctx: ProgramContext, input: string | { peer_id?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const peerId = args?.peer_id;
			if (!peerId) throw new Error("discord.typing: peer_id required");
			return await doTyping(peerId, ctx.state, ctx);
		},

		/** Trigger a poll cycle now. */
		poll: async (ctx: ProgramContext) => {
			return await runPoll(ctx.state, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	splitMessage,
	doSend,
	doSendChannel,
	doTyping,
	runPoll,
	pollPeer,
	buildIdentifyPayload,
	computeReconnectDelayMs,
	shouldSendHeartbeat,
	isHeartbeatAckOverdue,
	shouldReconnectOnClose,
	handleGatewayFrame,
	openGateway,
	tickGateway,
	closeGateway,
};

// silence unused-warning for helpers we export only via __test
void yellow;
