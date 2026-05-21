// peer-chat — agent-to-agent text messaging over Discord pair channels.
//
// Every conversation hop — same-daemon or cross-daemon — rides on a Discord
// pair channel managed by the admin bot in /discord. There is no in-process
// shortcut for local-to-local A2A; even Mikey ↔ Holdfast on the same daemon
// round-trips through Discord. This keeps the data model uniform: one
// channel per pair, one envelope per message, both perspectives
// reconstructed from the same Discord history.
//
// Identity model:
//   - Each agent has a globally unique `agent_uuid` (v4, minted at
//     /holdfast bootstrap) and a `display_name`. Both ride in every
//     envelope. The pair channel name is derived by hashing the two
//     agent_uuids and sorting deterministically.
//   - On the local daemon, /peer.agent_object_id maps a local agent's
//     UUID back to its rivetkit /agent object id so handleA2A can
//     dispatch /agent.ask when an inbound message lands.
//
// Trust model: the Discord bot token IS the auth boundary. Anyone with
// the token can post as any agent. /peer.trust_level is a UX gate on
// "who is this agent allowed to initiate / receive A2A with", not a
// cryptographic check. peer-chat enforces the gate on both ends.
//
// Conversation identity: `conversation_id` is the thread id, generated
// by the sender. It rides in every envelope and is the same on both
// sides of a thread. In actor state, conversations are keyed by
// `${owner_agent_object_id}::${conversation_id}` so both perspectives
// of a thread can coexist on the same daemon.

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

// Bumped 4 → 5 alongside the agent_uuid migration. Old persisted state
// (identity_pubkey-based) is wiped on first load.
const STATE_VERSION = 5;

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
	id: string;                            // conversation_id (thread id)
	peer_agent_uuid: string;
	peer_display_name: string;
	peer_object_id?: string;               // /peer record id
	goal: string;
	status: ConversationStatus;
	started_at: number;
	started_by_agent_object_id?: string;
	owner_agent_object_id: string;         // local rivetkit id of the agent that owns this view
	hop_cap: number;
	ended_at?: number;
	ended_reason?: string;
	ended_by_agent_object_id?: string;
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

function convKey(ownerAgentObjectId: string, conversationId: string): string {
	return `${ownerAgentObjectId}::${conversationId}`;
}

function lookupConv(state: Record<string, any>, ownerAgentObjectId: string, conversationId: string): Conversation | null {
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	return conversations[convKey(ownerAgentObjectId, conversationId)] ?? null;
}

function storeConv(state: Record<string, any>, conv: Conversation) {
	state.conversations = state.conversations ?? {};
	state.conversations[convKey(conv.owner_agent_object_id, conv.id)] = conv;
}

// ── Agent / peer lookups ─────────────────────────────────────────

interface LocalAgentPeer {
	peer_id: string;
	agent_object_id: string;     // local rivetkit object id (= /agent id)
	agent_uuid: string;          // globally unique v4
	display_name: string;
}

async function listLocalAgentPeers(ctx: ProgramContext): Promise<LocalAgentPeer[]> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	const out: LocalAgentPeer[] = [];
	for (const p of peers) {
		if (p.kind !== "agent") continue;
		const uuid = p.agent_uuid;
		const obj = p.agent_object_id;
		if (!uuid || !obj) continue; // not a local-on-this-daemon agent record
		out.push({
			peer_id: p.id,
			agent_object_id: obj,
			agent_uuid: uuid,
			display_name: p.display_name ?? obj,
		});
	}
	return out;
}

async function findLocalAgentByObjectId(ctx: ProgramContext, agentObjectId: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	return list.find((a) => a.agent_object_id === agentObjectId) ?? null;
}

async function findLocalAgentByUuid(ctx: ProgramContext, agentUuid: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	const want = agentUuid.toLowerCase();
	return list.find((a) => a.agent_uuid.toLowerCase() === want) ?? null;
}

interface ResolvedPeer {
	peer_id: string;
	agent_uuid: string;
	display_name: string;
}

/** Resolve a peer-chat target by peer_id / agent_uuid / display_name.
 *  Refuses non-peered or non-agent targets (peer-chat is agent-to-agent only). */
async function resolvePeerForChat(
	ctx: ProgramContext,
	ref: { peer_id?: string; agent_uuid?: string; display_name?: string },
): Promise<ResolvedPeer> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];

	const candidates = peers.filter((p) => {
		if (p.kind !== "agent") return false;
		if (ref.peer_id && p.id === ref.peer_id) return true;
		if (ref.agent_uuid && (p.agent_uuid ?? "").toLowerCase() === ref.agent_uuid.toLowerCase()) return true;
		if (ref.display_name && (p.display_name ?? "").toLowerCase() === ref.display_name.toLowerCase()) return true;
		return false;
	});

	const match = candidates.slice().sort((a, b) => {
		const aP = isPeered(a.trust_level) ? 1 : 0;
		const bP = isPeered(b.trust_level) ? 1 : 0;
		return bP - aP;
	})[0];

	if (!match) throw new Error(`peer-chat: no agent peer matches ${JSON.stringify(ref)}`);

	let effectiveTrust = match.trust_level;
	if (!isPeered(effectiveTrust) && match.host_peer_id) {
		const host = peers.find((p) => p.id === match.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		throw new Error(`peer-chat: peer "${match.display_name}" is at trust=${match.trust_level}; need a peered trust level.`);
	}
	if (!match.agent_uuid) {
		throw new Error(`peer-chat: peer "${match.display_name}" has no agent_uuid on record (re-bootstrap may be needed)`);
	}

	return {
		peer_id: match.id,
		agent_uuid: match.agent_uuid,
		display_name: match.display_name ?? match.id,
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
	from_agent_uuid: string;
	from_display_name: string;
	to_agent_uuid: string;
	to_display_name: string;
	body: unknown;
	in_reply_to: string | null;
	sent_at: number;
	goal?: string;
}

async function dispatchPostA2A(ctx: ProgramContext, envelope: A2AEnvelope): Promise<{ channel_id: string }> {
	const res = await ctx.dispatchProgram("/discord", "postA2A", [{
		peer_a_agent_uuid: envelope.from_agent_uuid,
		peer_b_agent_uuid: envelope.to_agent_uuid,
		envelope,
	}]) as { channel_id: string };
	if (!res?.channel_id) throw new Error("peer-chat: /discord postA2A returned no channel_id");
	return res;
}

// ── startConversation ────────────────────────────────────────────

interface StartConversationInput {
	peer_id?: string;
	agent_uuid?: string;
	display_name?: string;
	goal: string;
	text: string;
	from_agent_id?: string;        // bound by holdfast-tools — local rivetkit object id
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
		throw new Error("peer-chat startConversation: from_agent_id is required (the sender agent's local rivetkit id)");
	}

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) {
		throw new Error(`peer-chat startConversation: no local agent with object id ${input.from_agent_id} (missing /peer record with agent_uuid + agent_id link)`);
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
		from_agent_uuid: sender.agent_uuid,
		from_display_name: sender.display_name,
		to_agent_uuid: peer.agent_uuid,
		to_display_name: peer.display_name,
		body: input.text,
		in_reply_to: null,
		sent_at: now,
		goal: input.goal.trim(),
	};

	const posted = await dispatchPostA2A(ctx, envelope);

	const conv: Conversation = {
		id: conversation_id,
		peer_agent_uuid: peer.agent_uuid,
		peer_display_name: peer.display_name,
		peer_object_id: peer.peer_id,
		goal: input.goal.trim(),
		status: "active",
		started_at: now,
		started_by_agent_object_id: sender.agent_object_id,
		owner_agent_object_id: sender.agent_object_id,
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

// ── send ────────────────────────────────────────────────────────

interface SendInput {
	conversation_id: string;
	text: string;
	in_reply_to?: string | null;
	from_agent_id?: string;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ msg_id: string }> {
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat send: `text` is required");
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

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat send: no local agent with object id ${input.from_agent_id}`);

	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const sent_at = Date.now();

	const envelope: A2AEnvelope = {
		v: 1,
		msg_id,
		conversation_id: conv.id,
		kind: "text",
		from_agent_uuid: sender.agent_uuid,
		from_display_name: sender.display_name,
		to_agent_uuid: conv.peer_agent_uuid,
		to_display_name: conv.peer_display_name,
		body: input.text,
		in_reply_to: input.in_reply_to ?? null,
		sent_at,
	};
	await dispatchPostA2A(ctx, envelope);

	const result = appendMessageToConversation(state, conv, {
		msg_id, conversation_id: conv.id, direction: "out", kind: "text",
		in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
	});
	await persistIfChanged(state, ctx);
	if (result.pausedNow) await notifyPauseForReview(ctx, conv);
	return { msg_id };
}

// ── endConversation ─────────────────────────────────────────────

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

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat endConversation: no local agent with object id ${input.from_agent_id}`);

	const now = Date.now();
	const reason = (input.reason ?? "").toString().slice(0, 200) || "no reason given";

	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const envelope: A2AEnvelope = {
		v: 1,
		msg_id,
		conversation_id: conv.id,
		kind: "done",
		from_agent_uuid: sender.agent_uuid,
		from_display_name: sender.display_name,
		to_agent_uuid: conv.peer_agent_uuid,
		to_display_name: conv.peer_display_name,
		body: reason,
		in_reply_to: null,
		sent_at: now,
	};
	try {
		await dispatchPostA2A(ctx, envelope);
	} catch (err: any) {
		ctx.print?.(dim(`[peer-chat] end-conversation envelope send failed: ${err?.message ?? err}`));
	}

	conv.status = "done";
	conv.ended_at = now;
	conv.ended_reason = reason;
	conv.ended_by_agent_object_id = sender.agent_object_id;
	storeConv(state, conv);
	await persistIfChanged(state, ctx);
	return { ok: true };
}

// ── resumeConversation ─────────────────────────────────────────

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
		await ctx.dispatchProgram("/agent", "ask", [conv.owner_agent_object_id, prompt]);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] auto-trigger failed for ${conv.owner_agent_object_id}/${conv.id}: ${err?.message ?? err}`));
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
	if (!env || typeof env !== "object") return { processed: false, reason: "no envelope" };
	if (env.v !== 1 || typeof env.msg_id !== "string" || typeof env.conversation_id !== "string") {
		return { processed: false, reason: "envelope shape invalid" };
	}
	if (!env.to_agent_uuid || !env.from_agent_uuid) {
		return { processed: false, reason: "envelope missing agent_uuids" };
	}
	if (env.kind === "text") {
		if (typeof env.body !== "string") return { processed: false, reason: "text body not string" };
		if ((env.body as string).length > MAX_BODY_LEN) return { processed: false, reason: "text body too long" };
	}

	// Is the recipient a LOCAL agent on this daemon?
	const recipient = await findLocalAgentByUuid(ctx, env.to_agent_uuid);
	if (!recipient) {
		// Either our own outbound being polled back (we're the sender, not the
		// recipient) or the envelope targets a different daemon's agent.
		return { processed: false, reason: "no local recipient" };
	}

	// Trust gate: the sender's /peer record must be peered (directly or via
	// host inheritance for cross-daemon agents).
	const allPeers = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const senderPeer = (Array.isArray(allPeers) ? allPeers : [])
		.find((p) => p.kind === "agent" && (p.agent_uuid ?? "").toLowerCase() === env.from_agent_uuid.toLowerCase());
	if (!senderPeer) {
		ctx.print?.(dim(`[peer-chat] dropped inbound: sender agent_uuid ${env.from_agent_uuid.slice(0, 12)}… not in /peer`));
		return { processed: false, reason: "sender not in /peer" };
	}
	let effectiveTrust = senderPeer.trust_level;
	if (!isPeered(effectiveTrust) && senderPeer.host_peer_id) {
		const host = (Array.isArray(allPeers) ? allPeers : []).find((p) => p.id === senderPeer.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		ctx.print?.(dim(`[peer-chat] dropped inbound: sender ${senderPeer.display_name} at trust=${senderPeer.trust_level}`));
		return { processed: false, reason: "sender not peered" };
	}

	const state = ctx.state;
	let conv = lookupConv(state, recipient.agent_object_id, env.conversation_id);

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
			peer_agent_uuid: env.from_agent_uuid,
			peer_display_name: env.from_display_name || senderPeer.display_name || "(unknown)",
			peer_object_id: senderPeer.id,
			goal: env.goal ?? "(no goal in envelope)",
			status: "active",
			started_at: env.sent_at,
			started_by_agent_object_id: undefined,
			owner_agent_object_id: recipient.agent_object_id,
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

	if (!result.appended) return { processed: false, reason: "duplicate msg_id" };

	if (conv.status === "active") void maybeAutoTrigger(ctx, conv);
	if (result.pausedNow) await notifyPauseForReview(ctx, conv);
	return { processed: true };
}

// ── Read actions ─────────────────────────────────────────────────

interface ListConversationsInput {
	peer_id?: string;
	agent_uuid?: string;
	status?: ConversationStatus;
	from_agent_id?: string;        // local rivetkit id
}

async function doListConversations(ctx: ProgramContext, input?: ListConversationsInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	const i = input ?? {};
	return Object.values(conversations)
		.filter((c) => {
			if (i.peer_id && c.peer_object_id !== i.peer_id) return false;
			if (i.status && c.status !== i.status) return false;
			if (i.agent_uuid && c.peer_agent_uuid.toLowerCase() !== i.agent_uuid.toLowerCase()) return false;
			if (i.from_agent_id && c.owner_agent_object_id !== i.from_agent_id) return false;
			return true;
		})
		.sort((a, b) => b.last_message_at - a.last_message_at)
		.map((c) => ({
			conversation_id: c.id,
			peer_agent_uuid: c.peer_agent_uuid,
			peer_display_name: c.peer_display_name,
			peer_object_id: c.peer_object_id,
			goal: c.goal,
			status: c.status,
			started_at: c.started_at,
			owner_agent_object_id: c.owner_agent_object_id,
			ended_at: c.ended_at,
			ended_reason: c.ended_reason,
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
	agent_uuid?: string;
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
	} else if (input.agent_uuid || input.peer_id) {
		const matches = Object.values(conversations).filter((c) => {
			if (input.agent_uuid && c.peer_agent_uuid.toLowerCase() !== input.agent_uuid.toLowerCase()) return false;
			if (input.peer_id && c.peer_object_id !== input.peer_id) return false;
			if (input.from_agent_id && c.owner_agent_object_id !== input.from_agent_id) return false;
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
	agent_uuid?: string;
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
			(input.agent_uuid && c.peer_agent_uuid.toLowerCase() === input.agent_uuid.toLowerCase()) ||
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

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
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
			print(`  ${statusTag} ${cyan(c.peer_display_name)} ${dim(`[owner ${c.owner_agent_object_id.slice(0, 8)}]`)}  ${dim(`"${(c.goal || "").slice(0, 40)}"`)}  ${dim(`${c.message_count} msgs, ${age}s ago`)}${unread}`);
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
			description: "Start a new goal-driven A2A conversation. Requires goal (1-280 chars), opening text, and from_agent_id (the sender agent's local rivetkit id). Posts the opening envelope into the pair channel under GLON_A2A_DISCORD_GUILD and returns conversation_id.",
			inputSchema: {
				type: "object",
				required: ["goal", "text"],
				properties: {
					peer_id: { type: "string" },
					agent_uuid: { type: "string" },
					display_name: { type: "string" },
					goal: { type: "string" },
					text: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: StartConversationInput) => doStartConversation(ctx, input),
		},
		send: {
			description: "Send a message into an existing active conversation. Requires conversation_id + from_agent_id. Posts an envelope to the pair channel.",
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
			description: "Close a conversation. Posts a kind:done envelope so the remote closes too.",
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
			description: "Resume a paused conversation (extends hop cap, re-fires auto-trigger if waiting on a reply).",
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
					agent_uuid: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: ListConversationsInput) => doListConversations(ctx, input ?? {}),
		},
		listMessages: {
			description: "Return messages in a conversation. Prefer conversation_id + from_agent_id; agent_uuid/peer_id falls back to most-recent matching.",
			inputSchema: {
				type: "object",
				properties: {
					conversation_id: { type: "string" },
					peer_id: { type: "string" },
					agent_uuid: { type: "string" },
					from_agent_id: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			handler: async (ctx, input: ListMessagesInput) => doListMessages(ctx, input ?? {}),
		},
		markRead: {
			description: "Reset unread_count for a conversation.",
			inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, peer_id: { type: "string" }, agent_uuid: { type: "string" }, from_agent_id: { type: "string" } } },
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
