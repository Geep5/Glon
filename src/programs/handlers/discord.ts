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

async function pollPeer(peer: PeerSnapshot, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!peer.discord_id) return 0;
	state.watermarks = state.watermarks ?? {};

	const channelId = await getDmChannel(peer, state);
	const watermark = state.watermarks[channelId];

	const qs = watermark ? `?limit=10&after=${watermark}` : `?limit=1`;
	const msgs = await discord("GET", `/channels/${channelId}/messages${qs}`) as DiscordMessage[] | null;
	if (!msgs || msgs.length === 0) return 0;

	// First tick per channel: set watermark without processing (avoid replaying history).
	if (!watermark) {
		state.watermarks[channelId] = msgs[0].id;
		return 0;
	}

	const botUserId = await getBotUserId(state);
	// Discord returns newest-first; process oldest-first.
	const sorted = [...msgs].sort((a, b) => a.id.localeCompare(b.id));
	let processed = 0;

	for (const m of sorted) {
		// Update watermark aggressively so we don't re-process on crash.
		if (m.id > (state.watermarks[channelId] as string)) state.watermarks[channelId] = m.id;

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
	}),

	onCreate: async (ctx: ProgramContext) => {
		// Warm up the bot user id on startup (non-fatal if it fails — tick retries).
		if (!process.env.DISCORD_BOT_TOKEN) return;
		try {
			await getBotUserId(ctx.state);
		} catch {
			// Log handled in tick loop.
		}
	},

	tickMs: DEFAULT_POLL_MS,

	onTick: async (ctx: ProgramContext) => {
		if (!process.env.DISCORD_BOT_TOKEN) return;
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
};

// silence unused-warning for helpers we export only via __test
void yellow;
