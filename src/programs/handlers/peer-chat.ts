// peer-chat — agent-to-agent text messaging over Discord pair channels.
//
// Every conversation hop — same-daemon or cross-daemon — rides on a Discord
// pair channel managed by the admin bot in /discord. There is no in-process
// shortcut for local-to-local A2A; even Mikey ↔ Holdfast on the same daemon
// round-trips through Discord. This keeps the data model uniform: one
// channel per pair, one envelope per message, both perspectives
// reconstructed from the same Discord history.
//
// Trust gate: /peer isPeered() — trust_level ∈ {trusted, friend, family, self}.
//
// Conversation identity:
//   - `conversation_id` (a.k.a. thread_id) is the sender-generated id that
//     rides in every envelope. Both sides reference the same id.
//   - In actor state, conversations are keyed by `${owner_agent_id}::${conversation_id}`
//     so a sender's view and the recipient's view can coexist on the same
//     daemon. Both records' public `id` field is the bare conversation_id.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { randomUUID } from "node:crypto";

const PEER_TRUSTED_LEVELS = new Set(["trusted", "friend", "family", "self"]);
function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}

// ── Constants ────────────────────────────────────────────────────

const PERSISTED_STATE_FIELD = "persisted_state";
const MAX_MESSAGES_PER_CONVERSATION = 2000;
const MAX_BODY_LEN = 8000;

const PAUSE_FOR_REVIEW_AT_HOPS = 50;

// Bumped from 3 → 4: dropped mirror_conversation_id + peer_hyperswarm_pubkey,
// added thread_id semantics. State on disk under the old version is wiped
// on first load (no migration; peer-chat history isn't precious).
const STATE_VERSION = 4;

// ── Types ────────────────────────────────────────────────────────

export interface PeerMessage {
	msg_id: string;
	conversation_id: string;
	direction: "in" | "out";
	kind: string;
	in_reply_to: string | null;
	body: unknown;
	sent_at: number;
}

export type ConversationStatus = "active" | "done" | "paused";

export interface Conversation {
	id: string;                            // public conversation_id (thread id)
	peer_identity_pubkey: string;
	peer_display_name: string;
	peer_object_id?: string;
	peer_agent_id?: string;
	goal: string;
	status: ConversationStatus;
	started_at: number;
	started_by_agent_id?: string;
	owner_agent_id: string;                // which local agent this view belongs to
	hop_cap: number;
	ended_at?: number;
	ended_reason?: string;
	ended_by_agent_id?: string;
	paused_at?: number;
	resumed_count?: number;
	messages: PeerMessage[];
	last_message_at: number;
	unread_count: number;
	last_discord_message_id?: string;
}

interface PersistedChatState {
	version: number;
	conversations: Record<string, Conversation>;
}

// ── Persistence ─────────────────────────────────────────────────

function snapshotState(state: Record<string, any>): string {
	return JSON.stringify({ version: STATE_VERSION, conversations: state.conversations ?? {} });
}

async function restoreState(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedChatState;
		if (parsed.version !== STATE_VERSION) {
			ctx.print?.(dim(`  [peer-chat] resetting state (version ${parsed.version ?? "?"} → ${STATE_VERSION})`));
			state.conversations = {};
			state._lastPersistedSnapshot = snapshotState(state);
			return;
		}
		if (parsed.conversations) state.conversations = parsed.conversations;
		state._lastPersistedSnapshot = snapshotState(state);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] restore failed: ${err?.message ?? String(err)}`));
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
		ctx.print?.(dim(`  [peer-chat] persist failed: ${err?.message ?? String(err)}`));
	}
}

// ── State key helpers ────────────────────────────────────────────

function convKey(ownerAgentId: string, conversationId: string): string {
	return `${ownerAgentId}::${conversationId}`;
}

function lookupConv(state: Record<string, any>, ownerAgentId: string, conversationId: string): Conversation | null {
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	return conversations[convKey(ownerAgentId, conversationId)] ?? null;
}

function storeConv(state: Record<string, any>, conv: Conversation) {
	state.conversations = state.conversations ?? {};
	state.conversations[convKey(conv.owner_agent_id, conv.id)] = conv;
}

// ── Agent / peer lookups ─────────────────────────────────────────

interface LocalAgentPeer {
	peer_id: string;
	agent_id: string;            // local agent id (the part after "local:")
	identity_pubkey: string;     // "local:<agent_id>"
	display_name: string;
}

async function listLocalAgentPeers(ctx: ProgramContext): Promise<LocalAgentPeer[]> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	const out: LocalAgentPeer[] = [];
	for (const p of peers) {
		const ident = String(p.identity_pubkey ?? "");
		if (!ident.startsWith("local:")) continue;
		const agent_id = ident.slice("local:".length);
		if (!agent_id) continue;
		out.push({
			peer_id: p.id,
			agent_id,
			identity_pubkey: ident,
			display_name: p.display_name ?? agent_id,
		});
	}
	return out;
}

async function findLocalAgentByAgentId(ctx: ProgramContext, agentId: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	return list.find((a) => a.agent_id === agentId) ?? null;
}

async function findLocalAgentByIdentityPubkey(ctx: ProgramContext, identityPubkey: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	const want = identityPubkey.toLowerCase();
	return list.find((a) => a.identity_pubkey.toLowerCase() === want) ?? null;
}

interface ResolvedPeer {
	peer_id: string;
	identity_pubkey: string;
	display_name: string;
	agent_id_remote?: string;
}

/** Resolve a peer-chat target by peer_id / identity_pubkey / display_name.
 *  Refuses non-peered targets. Returns the same shape regardless of whether
 *  the target is local-on-this-daemon or remote. */
async function resolvePeerForChat(
	ctx: ProgramContext,
	ref: { peer_id?: string; identity_pubkey?: string; display_name?: string },
): Promise<ResolvedPeer> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];

	const candidates = peers.filter((p) => {
		if (ref.peer_id && p.id === ref.peer_id) return true;
		if (ref.identity_pubkey && (p.identity_pubkey ?? "").toLowerCase() === ref.identity_pubkey.toLowerCase()) return true;
		if (ref.display_name && (p.display_name ?? "").toLowerCase() === ref.display_name.toLowerCase()) return true;
		return false;
	});

	const rank = (p: any) => {
		let s = 0;
		if (isPeered(p.trust_level)) s += 100;
		if (p.kind === "agent") s += 10;
		return s;
	};
	const match = candidates.slice().sort((a, b) => rank(b) - rank(a))[0];

	if (!match) throw new Error(`peer-chat: no peer matches ${JSON.stringify(ref)}. Have you peered with them?`);

	let effectiveTrust = match.trust_level;
	if (!isPeered(effectiveTrust) && match.kind === "agent" && match.host_peer_id) {
		const host = peers.find((p) => p.id === match.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		throw new Error(`peer-chat: peer "${match.display_name}" is at trust=${match.trust_level}; need a peered trust level.`);
	}
	if (!match.identity_pubkey) throw new Error(`peer-chat: peer "${match.display_name}" has no identity_pubkey on record`);

	// Derive a remote-agent id if available. For local agents the identity
	// pubkey itself encodes the agent id ("local:<agent_id>"); for remote
	// agents the field is explicit.
	let agent_id_remote: string | undefined = match.agent_id_remote;
	if (!agent_id_remote && String(match.identity_pubkey).startsWith("local:")) {
		agent_id_remote = String(match.identity_pubkey).slice("local:".length);
	}

	return {
		peer_id: match.id,
		identity_pubkey: match.identity_pubkey,
		display_name: match.display_name ?? match.id,
		agent_id_remote,
	};
}

// ── Conversation helpers ─────────────────────────────────────────

function newConversationId(): string {
	return `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function appendMessageToConversation(state: Record<string, any>, conv: Conversation, msg: PeerMessage): { pausedNow: boolean; appended: boolean } {
	if (conv.messages.some((m) => m.msg_id === msg.msg_id)) return { pausedNow: false, appended: false };
	conv.messages.push(msg);
	if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
		conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
	}
	conv.last_message_at = msg.sent_at;
	if (msg.direction === "in") conv.unread_count += 1;

	let pausedNow = false;
	const cap = conv.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS;
	if (conv.status === "active" && conv.messages.length >= cap) {
		conv.status = "paused";
		conv.paused_at = msg.sent_at;
		pausedNow = true;
	}
	storeConv(state, conv);
	return { pausedNow, appended: true };
}

async function notifyPauseForReview(ctx: ProgramContext, conv: Conversation): Promise<void> {
	try {
		const peerName = conv.peer_display_name || "(peer)";
		const hops = conv.messages.length;
		const text = `peer-chat: "${conv.goal}" with ${peerName} hit ${hops} hops — continue or stop?`;
		await ctx.dispatchProgram("/user-chat", "notify", [{ text, urgency: "normal", source: "peer-chat" }]);
	} catch { /* best-effort */ }
}

// ── Envelope construction ───────────────────────────────────────

interface A2AEnvelope {
	v: 1;
	msg_id: string;
	conversation_id: string;
	kind: "text" | "done";
	from_identity_pubkey: string;
	from_agent_id?: string;
	from_display_name?: string;
	to_identity_pubkey: string;
	to_agent_id?: string;
	to_display_name?: string;
	body: unknown;
	in_reply_to: string | null;
	sent_at: number;
	goal?: string;
}

interface PostA2AOptions {
	envelope: A2AEnvelope;
	from_identity_pubkey: string;
	to_identity_pubkey: string;
}

async function dispatchPostA2A(ctx: ProgramContext, opts: PostA2AOptions): Promise<{ channel_id: string }> {
	const res = await ctx.dispatchProgram("/discord", "postA2A", [{
		peer_a_identity_pubkey: opts.from_identity_pubkey,
		peer_b_identity_pubkey: opts.to_identity_pubkey,
		envelope: opts.envelope,
	}]) as { channel_id: string };
	if (!res?.channel_id) throw new Error("peer-chat: /discord postA2A returned no channel_id");
	return res;
}

// ── startConversation ────────────────────────────────────────────

interface StartConversationInput {
	peer_id?: string;
	identity_pubkey?: string;
	display_name?: string;
	goal: string;
	text: string;
	from_agent_id?: string;
}

interface StartConversationResult {
	conversation_id: string;
	msg_id: string;
	discord_channel_id: string;
}

async function doStartConversation(ctx: ProgramContext, input: StartConversationInput): Promise<StartConversationResult> {
	if (typeof input?.goal !== "string" || input.goal.trim().length === 0) {
		throw new Error("peer-chat startConversation: `goal` is required and must be a non-empty string");
	}
	if (input.goal.length > 280) {
		throw new Error(`peer-chat startConversation: goal too long (${input.goal.length} > 280)`);
	}
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat startConversation: `text` is required (the opening message)");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat startConversation: text too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}
	if (!input.from_agent_id) {
		throw new Error("peer-chat startConversation: from_agent_id is required (each conversation belongs to a sender agent)");
	}

	const sender = await findLocalAgentByAgentId(ctx, input.from_agent_id);
	if (!sender) {
		throw new Error(`peer-chat startConversation: no local agent with id ${input.from_agent_id} (need a /peer record with identity_pubkey=local:${input.from_agent_id})`);
	}

	const peer = await resolvePeerForChat(ctx, input);

	const state = ctx.state;
	const now = Date.now();
	const conversation_id = newConversationId();
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);

	const envelope: A2AEnvelope = {
		v: 1,
		msg_id,
		conversation_id,
		kind: "text",
		from_identity_pubkey: sender.identity_pubkey,
		from_agent_id: sender.agent_id,
		from_display_name: sender.display_name,
		to_identity_pubkey: peer.identity_pubkey,
		to_agent_id: peer.agent_id_remote,
		to_display_name: peer.display_name,
		body: input.text,
		in_reply_to: null,
		sent_at: now,
		goal: input.goal.trim(),
	};

	const posted = await dispatchPostA2A(ctx, {
		envelope,
		from_identity_pubkey: sender.identity_pubkey,
		to_identity_pubkey: peer.identity_pubkey,
	});

	const conv: Conversation = {
		id: conversation_id,
		peer_identity_pubkey: peer.identity_pubkey,
		peer_display_name: peer.display_name,
		peer_object_id: peer.peer_id,
		peer_agent_id: peer.agent_id_remote,
		goal: input.goal.trim(),
		status: "active",
		started_at: now,
		started_by_agent_id: sender.agent_id,
		owner_agent_id: sender.agent_id,
		hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
		messages: [],
		last_message_at: 0,
		unread_count: 0,
	};
	storeConv(state, conv);
	appendMessageToConversation(state, conv, {
		msg_id, conversation_id, direction: "out", kind: "text",
		in_reply_to: null, body: input.text, sent_at: now,
	});
	await persistIfChanged(state, ctx);

	return { conversation_id, msg_id, discord_channel_id: posted.channel_id };
}

// ── send: continue an existing active conversation ──────────────

interface SendInput {
	conversation_id: string;
	text: string;
	in_reply_to?: string | null;
	from_agent_id?: string;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ msg_id: string }> {
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat send: `text` is required and must be a non-empty string");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat send: message too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat send: `conversation_id` is required");
	}
	if (!input.from_agent_id) {
		throw new Error("peer-chat send: from_agent_id is required");
	}

	const state = ctx.state;
	const conv = lookupConv(state, input.from_agent_id, input.conversation_id);
	if (!conv) throw new Error(`peer-chat send: conversation ${input.conversation_id} not found for agent ${input.from_agent_id}`);
	if (conv.status !== "active") {
		throw new Error(`peer-chat send: conversation ${input.conversation_id} is ${conv.status} — start a new one to continue.`);
	}

	const sender = await findLocalAgentByAgentId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat send: no local agent with id ${input.from_agent_id}`);

	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const sent_at = Date.now();

	const envelope: A2AEnvelope = {
		v: 1,
		msg_id,
		conversation_id: conv.id,
		kind: "text",
		from_identity_pubkey: sender.identity_pubkey,
		from_agent_id: sender.agent_id,
		from_display_name: sender.display_name,
		to_identity_pubkey: conv.peer_identity_pubkey,
		to_agent_id: conv.peer_agent_id,
		to_display_name: conv.peer_display_name,
		body: input.text,
		in_reply_to: input.in_reply_to ?? null,
		sent_at,
	};
	await dispatchPostA2A(ctx, {
		envelope,
		from_identity_pubkey: sender.identity_pubkey,
		to_identity_pubkey: conv.peer_identity_pubkey,
	});

	const result = appendMessageToConversation(state, conv, {
		msg_id, conversation_id: conv.id, direction: "out", kind: "text",
		in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
	});
	await persistIfChanged(state, ctx);
	if (result.pausedNow) await notifyPauseForReview(ctx, conv);
	return { msg_id };
}

// ── endConversation: one-sided "done" closes the thread ──────────

interface EndConversationInput {
	conversation_id: string;
	reason?: string;
	from_agent_id?: string;
}

async function doEndConversation(ctx: ProgramContext, input: EndConversationInput): Promise<{ ok: true }> {
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat endConversation: `conversation_id` is required");
	}
	if (!input.from_agent_id) {
		throw new Error("peer-chat endConversation: from_agent_id is required");
	}

	const state = ctx.state;
	const conv = lookupConv(state, input.from_agent_id, input.conversation_id);
	if (!conv) throw new Error(`peer-chat endConversation: conversation ${input.conversation_id} not found for agent ${input.from_agent_id}`);
	if (conv.status === "done") return { ok: true };

	const sender = await findLocalAgentByAgentId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat endConversation: no local agent with id ${input.from_agent_id}`);

	const now = Date.now();
	const reason = (input.reason ?? "").toString().slice(0, 200) || "no reason given";

	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const envelope: A2AEnvelope = {
		v: 1,
		msg_id,
		conversation_id: conv.id,
		kind: "done",
		from_identity_pubkey: sender.identity_pubkey,
		from_agent_id: sender.agent_id,
		from_display_name: sender.display_name,
		to_identity_pubkey: conv.peer_identity_pubkey,
		to_agent_id: conv.peer_agent_id,
		to_display_name: conv.peer_display_name,
		body: reason,
		in_reply_to: null,
		sent_at: now,
	};
	try {
		await dispatchPostA2A(ctx, {
			envelope,
			from_identity_pubkey: sender.identity_pubkey,
			to_identity_pubkey: conv.peer_identity_pubkey,
		});
	} catch (err: any) {
		ctx.print?.(dim(`[peer-chat] end-conversation envelope send failed: ${err?.message ?? err}`));
	}

	conv.status = "done";
	conv.ended_at = now;
	conv.ended_reason = reason;
	conv.ended_by_agent_id = sender.agent_id;
	storeConv(state, conv);
	await persistIfChanged(state, ctx);
	return { ok: true };
}

// ── resumeConversation: user re-greenlights a paused thread ──────

interface ResumeConversationInput {
	conversation_id: string;
	from_agent_id?: string;
}

async function doResumeConversation(ctx: ProgramContext, input: ResumeConversationInput): Promise<{ ok: true; new_hop_cap: number }> {
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat resumeConversation: `conversation_id` is required");
	}
	if (!input.from_agent_id) {
		throw new Error("peer-chat resumeConversation: from_agent_id is required");
	}
	const state = ctx.state;
	const conv = lookupConv(state, input.from_agent_id, input.conversation_id);
	if (!conv) throw new Error(`peer-chat resumeConversation: conversation ${input.conversation_id} not found for agent ${input.from_agent_id}`);
	if (conv.status === "done") {
		throw new Error("peer-chat resumeConversation: conversation is done — start a new one to continue.");
	}
	conv.hop_cap = conv.messages.length + PAUSE_FOR_REVIEW_AT_HOPS;
	conv.status = "active";
	conv.resumed_count = (conv.resumed_count ?? 0) + 1;
	conv.paused_at = undefined;
	storeConv(state, conv);
	await persistIfChanged(state, ctx);
	const last = conv.messages[conv.messages.length - 1];
	if (last?.direction === "in") void maybeAutoTrigger(ctx, conv);
	return { ok: true, new_hop_cap: conv.hop_cap };
}

// ── Auto-trigger ─────────────────────────────────────────────────

async function maybeAutoTrigger(ctx: ProgramContext, conv: Conversation): Promise<void> {
	try {
		if (conv.status !== "active") return;
		const last = conv.messages[conv.messages.length - 1];
		if (!last || last.direction !== "in") return;
		const goalPreview = conv.goal ? conv.goal.slice(0, 200) : "(no goal stated)";
		const bodyPreview = String(last.body ?? "").slice(0, 1500);
		const prompt = [
			`You have a new peer-chat message in an active conversation.`,
			`Conversation id: ${conv.id}`,
			`Goal: ${goalPreview}`,
			`From: ${conv.peer_display_name}`,
			`Message: ${bodyPreview}`,
			``,
			`If the goal is achieved or further reply would not add value, call peer_conversation_done with a short reason. Otherwise, call peer_message_send with this conversation_id to reply. Do NOT ask the human user — this is autonomous A2A.`,
		].join("\n");
		await ctx.dispatchProgram("/agent", "ask", [conv.owner_agent_id, prompt]);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] auto-trigger failed for ${conv.owner_agent_id}/${conv.id}: ${err?.message ?? err}`));
	}
}

// ── handleA2A: inbound envelope from /discord poll ──────────────

interface HandleA2AInput {
	envelope: A2AEnvelope;
	channel_id?: string;
	discord_message_id?: string;
}

async function doHandleA2A(ctx: ProgramContext, input: HandleA2AInput): Promise<{ processed: boolean; reason?: string }> {
	const env = input?.envelope;
	if (!env || typeof env !== "object") {
		return { processed: false, reason: "no envelope" };
	}
	if (env.v !== 1 || typeof env.msg_id !== "string" || typeof env.conversation_id !== "string") {
		return { processed: false, reason: "envelope shape invalid" };
	}
	if (env.kind === "text") {
		if (typeof env.body !== "string") return { processed: false, reason: "text body not string" };
		if ((env.body as string).length > MAX_BODY_LEN) return { processed: false, reason: "text body too long" };
	}

	// Is the recipient one of THIS daemon's agents?
	const recipient = env.to_identity_pubkey ? await findLocalAgentByIdentityPubkey(ctx, env.to_identity_pubkey) : null;
	if (!recipient) {
		// We're not the recipient — this envelope is either our own outbound
		// being polled back, or it targets some other glon. Either way, skip.
		return { processed: false, reason: "no local recipient" };
	}

	// Trust gate: the sender must be peered with us. For local sender we
	// already have a /peer record with identity_pubkey="local:..." (assumed
	// peered for siblings on the same daemon). For remote senders the trust
	// must be set explicitly by the human.
	const senderPeerRecords = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const senderPeer = (Array.isArray(senderPeerRecords) ? senderPeerRecords : [])
		.find((p) => (p.identity_pubkey ?? "").toLowerCase() === (env.from_identity_pubkey ?? "").toLowerCase());
	if (!senderPeer) {
		ctx.print?.(dim(`[peer-chat] dropped inbound from unknown sender ${env.from_identity_pubkey?.slice(0, 16) ?? "?"}`));
		return { processed: false, reason: "sender not in /peer" };
	}
	let effectiveTrust = senderPeer.trust_level;
	if (!isPeered(effectiveTrust) && senderPeer.kind === "agent" && senderPeer.host_peer_id) {
		const host = (Array.isArray(senderPeerRecords) ? senderPeerRecords : []).find((p) => p.id === senderPeer.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		ctx.print?.(dim(`[peer-chat] dropped inbound: sender ${senderPeer.display_name} at trust=${senderPeer.trust_level}`));
		return { processed: false, reason: "sender not peered" };
	}

	const state = ctx.state;
	let conv = lookupConv(state, recipient.agent_id, env.conversation_id);

	if (env.kind === "done") {
		if (conv && conv.status !== "done") {
			conv.status = "done";
			conv.ended_at = env.sent_at;
			conv.ended_reason = String(env.body ?? "remote closed");
			storeConv(state, conv);
			await persistIfChanged(state, ctx);
		}
		return { processed: true };
	}

	if (!conv) {
		conv = {
			id: env.conversation_id,
			peer_identity_pubkey: env.from_identity_pubkey,
			peer_display_name: env.from_display_name || senderPeer.display_name || env.from_agent_id || "(unknown)",
			peer_object_id: senderPeer.id,
			peer_agent_id: env.from_agent_id,
			goal: env.goal ?? "(no goal in envelope)",
			status: "active",
			started_at: env.sent_at,
			started_by_agent_id: env.from_agent_id,
			owner_agent_id: recipient.agent_id,
			hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
			messages: [],
			last_message_at: 0,
			unread_count: 0,
			last_discord_message_id: input.discord_message_id,
		};
	} else if (input.discord_message_id) {
		conv.last_discord_message_id = input.discord_message_id;
	}

	const result = appendMessageToConversation(state, conv, {
		msg_id: env.msg_id,
		conversation_id: conv.id,
		direction: "in",
		kind: env.kind ?? "text",
		in_reply_to: env.in_reply_to ?? null,
		body: env.body,
		sent_at: env.sent_at,
	});
	await persistIfChanged(state, ctx);

	if (!result.appended) {
		return { processed: false, reason: "duplicate msg_id" };
	}

	if (conv.status === "active") void maybeAutoTrigger(ctx, conv);
	if (result.pausedNow) await notifyPauseForReview(ctx, conv);
	return { processed: true };
}

// ── Read actions ─────────────────────────────────────────────────

interface ListConversationsInput {
	peer_id?: string;
	identity_pubkey?: string;
	status?: ConversationStatus;
	from_agent_id?: string;
}

async function doListConversations(ctx: ProgramContext, input?: ListConversationsInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	const i = input ?? {};
	return Object.values(conversations)
		.filter((c) => {
			if (i.peer_id && c.peer_object_id !== i.peer_id) return false;
			if (i.status && c.status !== i.status) return false;
			if (i.identity_pubkey && c.peer_identity_pubkey.toLowerCase() !== i.identity_pubkey.toLowerCase()) return false;
			if (i.from_agent_id && c.owner_agent_id !== i.from_agent_id) return false;
			return true;
		})
		.sort((a, b) => b.last_message_at - a.last_message_at)
		.map((c) => ({
			conversation_id: c.id,
			peer_identity_pubkey: c.peer_identity_pubkey,
			peer_display_name: c.peer_display_name,
			peer_object_id: c.peer_object_id,
			peer_agent_id: c.peer_agent_id,
			goal: c.goal,
			status: c.status,
			started_at: c.started_at,
			started_by_agent_id: c.started_by_agent_id,
			owner_agent_id: c.owner_agent_id,
			ended_at: c.ended_at,
			ended_reason: c.ended_reason,
			ended_by_agent_id: c.ended_by_agent_id,
			last_message_at: c.last_message_at,
			unread_count: c.unread_count,
			message_count: c.messages.length,
			hop_cap: c.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS,
			hops_remaining: Math.max(0, (c.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS) - c.messages.length),
			paused_at: c.paused_at,
			resumed_count: c.resumed_count ?? 0,
			last_message_preview: c.messages.length > 0 ? String(c.messages[c.messages.length - 1].body ?? "").slice(0, 120) : "",
		}));
}

interface ListMessagesInput {
	conversation_id?: string;
	peer_id?: string;
	identity_pubkey?: string;
	from_agent_id?: string;
	since?: number;
	limit?: number;
}

async function doListMessages(ctx: ProgramContext, input: ListMessagesInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let conv: Conversation | null = null;
	if (input.conversation_id && input.from_agent_id) {
		conv = lookupConv(state, input.from_agent_id, input.conversation_id);
	} else if (input.identity_pubkey || input.peer_id) {
		const matches = Object.values(conversations).filter((c) => {
			if (input.identity_pubkey && c.peer_identity_pubkey.toLowerCase() !== input.identity_pubkey.toLowerCase()) return false;
			if (input.peer_id && c.peer_object_id !== input.peer_id) return false;
			if (input.from_agent_id && c.owner_agent_id !== input.from_agent_id) return false;
			return true;
		}).sort((a, b) => b.last_message_at - a.last_message_at);
		conv = matches[0] ?? null;
	}
	if (!conv) return [];
	const since = typeof input.since === "number" ? input.since : 0;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 500;
	return conv.messages.filter((m) => m.sent_at > since).slice(-limit);
}

interface MarkReadInput {
	conversation_id?: string;
	peer_id?: string;
	identity_pubkey?: string;
	from_agent_id?: string;
}

async function doMarkRead(ctx: ProgramContext, input: MarkReadInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let conv: Conversation | null = null;
	if (input.conversation_id && input.from_agent_id) {
		conv = lookupConv(state, input.from_agent_id, input.conversation_id);
	} else {
		const matches = Object.values(conversations).filter((c) =>
			(input.identity_pubkey && c.peer_identity_pubkey.toLowerCase() === input.identity_pubkey.toLowerCase()) ||
			(input.peer_id && c.peer_object_id === input.peer_id),
		);
		conv = matches[0] ?? null;
	}
	if (!conv) return { ok: true };
	if (conv.unread_count !== 0) {
		conv.unread_count = 0;
		await persistIfChanged(state, ctx);
	}
	return { ok: true };
}

async function doStatus(ctx: ProgramContext) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let in_count = 0, out_count = 0, unread = 0, active = 0, done = 0, paused = 0;
	for (const c of Object.values(conversations)) {
		unread += c.unread_count;
		for (const m of c.messages) (m.direction === "in" ? in_count++ : out_count++);
		if (c.status === "active") active++;
		else if (c.status === "done") done++;
		else if (c.status === "paused") paused++;
	}
	return {
		conversations: Object.keys(conversations).length,
		active, done, paused,
		messages_in: in_count,
		messages_out: out_count,
		unread,
	};
}

// ── CLI handler ─────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const s = await doStatus(ctx);
		print(bold("  peer-chat"));
		print(dim(`    conversations: ${s.conversations} (active ${s.active}, done ${s.done}, paused ${s.paused})`));
		print(dim(`    messages in:   ${s.messages_in}`));
		print(dim(`    messages out:  ${s.messages_out}`));
		print(dim(`    unread:        ${s.unread}`));
		return;
	}
	if (cmd === "list") {
		const convs = await doListConversations(ctx, {});
		if (convs.length === 0) { print(dim("(no conversations yet)")); return; }
		for (const c of convs) {
			const age = Math.round((Date.now() - c.last_message_at) / 1000);
			const unread = c.unread_count > 0 ? red(` (${c.unread_count} unread)`) : "";
			const statusTag = c.status === "active" ? green("●") : c.status === "done" ? dim("✓") : yellow("⌛");
			print(`  ${statusTag} ${cyan(c.peer_display_name)} ${dim(`[${c.owner_agent_id}]`)}  ${dim(`"${(c.goal || "").slice(0, 40)}"`)}  ${dim(`${c.message_count} msgs, ${age}s ago`)}${unread}`);
		}
		return;
	}
	print([
		bold("  peer-chat") + dim(" — agent-to-agent messaging over Discord pair channels"),
		`    ${cyan("/peer-chat list")}            list conversations`,
		`    ${cyan("/peer-chat status")}          counters`,
		dim("    Every message rides on a Discord pair channel under the glon-a2a category."),
		dim("    Set GLON_A2A_DISCORD_GUILD to the target guild (the admin bot manages channels)."),
	].join("\n"));
};

// ── Actor ───────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ conversations: {} }),
	onCreate: async (ctx) => {
		await restoreState(ctx.state, ctx);
	},
	typedActions: {
		startConversation: {
			description: "Start a new goal-driven conversation with a peer. Requires goal (1-280 chars), an opening text message, and from_agent_id (the sender agent on this daemon). Posts the opening envelope to the pair channel in GLON_A2A_DISCORD_GUILD and returns the local conversation_id.",
			inputSchema: {
				type: "object",
				required: ["goal", "text"],
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					display_name: { type: "string" },
					goal: { type: "string" },
					text: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: StartConversationInput) => doStartConversation(ctx, input),
		},
		send: {
			description: "Send a message into an existing active conversation. Requires conversation_id (from a prior startConversation or peer_conversations_list) and from_agent_id. Posts an envelope to the pair channel.",
			inputSchema: {
				type: "object",
				required: ["conversation_id", "text"],
				properties: {
					conversation_id: { type: "string" },
					text: { type: "string" },
					in_reply_to: { type: ["string", "null"] },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: SendInput) => doSend(ctx, input),
		},
		endConversation: {
			description: "Mark a conversation as done from this agent's side. Posts a kind:done envelope so the remote closes too.",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					reason: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: EndConversationInput) => doEndConversation(ctx, input),
		},
		resumeConversation: {
			description: "Resume a paused conversation (extends hop cap, re-fires the auto-trigger if waiting on a reply).",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: ResumeConversationInput) => doResumeConversation(ctx, input),
		},
		listConversations: {
			description: "List conversations. Pass from_agent_id to filter to a single agent's view.",
			inputSchema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: ListConversationsInput) => doListConversations(ctx, input ?? {}),
		},
		listMessages: {
			description: "Return messages in a conversation. Prefer conversation_id + from_agent_id; identity_pubkey/peer_id falls back to most-recent matching.",
			inputSchema: {
				type: "object",
				properties: {
					conversation_id: { type: "string" },
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					from_agent_id: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			handler: async (ctx, input: ListMessagesInput) => doListMessages(ctx, input ?? {}),
		},
		markRead: {
			description: "Reset unread_count for a conversation.",
			inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, peer_id: { type: "string" }, identity_pubkey: { type: "string" }, from_agent_id: { type: "string" } } },
			handler: async (ctx, input: MarkReadInput) => doMarkRead(ctx, input ?? {}),
		},
		status: {
			description: "Conversation counters across all local agents.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doStatus(ctx),
		},
		handleA2A: {
			description: "Process an inbound A2A envelope from /discord's pair-channel poll. Called by /discord, not by agents.",
			inputSchema: {
				type: "object",
				required: ["envelope"],
				properties: {
					envelope: { type: "object" },
					channel_id: { type: "string" },
					discord_message_id: { type: "string" },
				},
			},
			handler: async (ctx, input: HandleA2AInput) => doHandleA2A(ctx, input),
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = {
	doStartConversation, doSend, doEndConversation, doResumeConversation,
	doHandleA2A, doListConversations, doListMessages,
	convKey, lookupConv,
};
