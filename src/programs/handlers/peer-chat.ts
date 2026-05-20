// peer-chat — agent-to-agent text messaging.
//
// Same-daemon (local) A2A: one conversation per peered identity. The
// recipient agent's loop fires automatically on each inbound message via
// maybeAutoTrigger. Cross-machine peer-chat is currently unsupported —
// step 1 of the Discord-native switch removed the Hyperswarm transport;
// step 2 will wire a Discord channel transport back in.
//
// Trust gate (local routing) is /peer isPeered() — i.e. trust_level ∈
// {trusted, friend, family, self}.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { randomUUID } from "node:crypto";

const PEER_TRUSTED_LEVELS = new Set(["trusted", "friend", "family", "self"]);
function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}
// ── Constants ────────────────────────────────────────────────────

export const PEER_CHAT_CONTENT_TYPE = "glon/peer-chat";

const PERSISTED_STATE_FIELD = "persisted_state";
const MAX_MESSAGES_PER_CONVERSATION = 2000;
const MAX_BODY_LEN = 8000;

// When a conversation runs this many hops without explicit done, it
// pauses for human review rather than auto-killing. The user decides
// whether to continue (which extends the pause threshold by another
// chunk) or end via peer_conversation_done. No hard auto-kill —
// nothing dies without a human or an agent saying so.
const PAUSE_FOR_REVIEW_AT_HOPS = 50;

// Bump when the on-disk schema changes incompatibly; load() throws old data
// away and starts fresh. Acceptable since peer-chat history isn't precious.
const STATE_VERSION = 3;

// ── Types ────────────────────────────────────────────────────────

export interface PeerMessage {
	msg_id: string;
	conversation_id: string;
	direction: "in" | "out";
	kind: string;                 // "text" today; future: agent-request/response
	in_reply_to: string | null;
	body: unknown;
	sent_at: number;
}

export type ConversationStatus = "active" | "done" | "paused";

export interface Conversation {
	id: string;                            // conversation_id
	peer_identity_pubkey: string;
	peer_display_name: string;
	peer_object_id?: string;
	goal: string;                          // human-readable purpose
	status: ConversationStatus;
	started_at: number;
	started_by_agent_id?: string;
	owner_agent_id?: string;               // which local agent's perspective this conv is
	mirror_conversation_id?: string;       // links the other side's mirror for local convos
	hop_cap: number;                       // pause when messages.length >= hop_cap; user resume bumps by PAUSE_FOR_REVIEW_AT_HOPS
	ended_at?: number;
	ended_reason?: string;
	ended_by_agent_id?: string;
	paused_at?: number;
	resumed_count?: number;
	messages: PeerMessage[];
	last_message_at: number;
	unread_count: number;
}

interface PersistedChatState {
	version: number;
	conversations: Record<string, Conversation>;   // keyed by conversation_id
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
		// Schema migration: previous version was keyed by peer_identity_pubkey
		// and had no goal/status. Reset rather than translate — peer-chat
		// history isn't precious, and clean state avoids ambiguity.
		if (parsed.version !== STATE_VERSION) {
			ctx.print?.(dim(`  [peer-chat] resetting state (version ${parsed.version ?? "1"} → ${STATE_VERSION})`));
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

// ── Helpers ──────────────────────────────────────────────────────

	/** Find a peered /peer record by identity_pubkey, peer_id, or display_name. Refuses non-peered.
	 *  Returns `agent_id_remote` for remote-agent peers (the agent's id on
	 *  the host glon). Cross-machine routing is currently unsupported —
	 *  only local:<agentId> targets work until the Discord transport lands. */
	async function resolvePeerForChat(
		ctx: ProgramContext,
		ref: { peer_id?: string; identity_pubkey?: string; display_name?: string },
	): Promise<{ peer_id: string; identity_pubkey: string; display_name: string; agent_id_remote?: string }> {
		const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
		const peers = Array.isArray(all) ? all : [];

		// Collect candidates that match any provided ref field. Prefer
		// remote-agent records (kind=agent + agent_id_remote) over the
		// kind=human host record so display_name="Nova" routes to the
		// remote agent Nova rather than the human host who runs that glon.
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
		if (!match.identity_pubkey) throw new Error(`peer-chat: peer "${match.display_name}" has no identity_pubkey on record (can't address)`);
		return {
			peer_id: match.id,
			identity_pubkey: match.identity_pubkey,
			display_name: match.display_name ?? match.id,
			agent_id_remote: match.agent_id_remote,
		};
	}

	/** For a "local:<agentId>" target, look up the SENDER agent's own peer
	 *  record. Used to record the incoming side of an in-process message
	 *  in the recipient's view. */
	async function findLocalPeerForAgent(
		ctx: ProgramContext,
		agentId: string,
	): Promise<{ peer_id: string; identity_pubkey: string; display_name: string } | null> {
		const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
		const peers = Array.isArray(all) ? all : [];
		const want = `local:${agentId}`.toLowerCase();
		for (const p of peers) {
			if ((p.identity_pubkey ?? "").toLowerCase() === want) {
				return {
					peer_id: p.id,
					identity_pubkey: p.identity_pubkey,
					display_name: p.display_name ?? p.id,
				};
			}
		}
		return null;
	}

/** Generate a short opaque conversation id. */
function newConversationId(): string {
	return `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Push a new message into an existing conversation. Returns true if the
 *  conversation just crossed the pause threshold this append; the caller
 *  fires a /user-chat notification asking the human to continue or stop. */
function appendMessageToConversation(state: Record<string, any>, conv: Conversation, msg: PeerMessage): { pausedNow: boolean } {
	if (conv.messages.some((m) => m.msg_id === msg.msg_id)) return { pausedNow: false };
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
	state.conversations[conv.id] = conv;
	return { pausedNow };
}

/** Find an existing conversation by id. */
function getConversation(state: Record<string, any>, conversation_id: string): Conversation | null {
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	return conversations[conversation_id] ?? null;
}

/** Fire a /user-chat notification asking the human to continue or stop a
 *  paused conversation. Best-effort; never throws. */
async function notifyPauseForReview(ctx: ProgramContext, conv: Conversation): Promise<void> {
	try {
		const peerName = conv.peer_display_name || "(peer)";
		const hops = conv.messages.length;
		const text = `peer-chat: "${conv.goal}" with ${peerName} hit ${hops} hops — continue or stop?`;
		await ctx.dispatchProgram("/user-chat", "notify", [{ text, urgency: "normal", source: "peer-chat" }]);
	} catch { /* best-effort */ }
}

// ── startConversation ─────────────────────────────────────────────

interface StartConversationInput {
	peer_id?: string;
	identity_pubkey?: string;
	display_name?: string;
	goal: string;
	text: string;
	from_agent_id?: string;   // bound by tool
}

interface StartConversationResult {
	conversation_id: string;
	mirror_conversation_id?: string;
	msg_id: string;
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

	const peer = await resolvePeerForChat(ctx, input);
	const state = ctx.state;
	state.conversations = state.conversations ?? {};
	const now = Date.now();

	const isLocalTarget = String(peer.identity_pubkey).startsWith("local:");
	const conversation_id = newConversationId();
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);

	if (!isLocalTarget) {
		throw new Error(`peer-chat startConversation: cross-machine peer-chat is not available — the Hyperswarm transport was removed. Wire the Discord transport (step 2) before talking to "${peer.display_name}".`);
	}
	if (!input.from_agent_id) {
		throw new Error(`peer-chat startConversation: local-target peer requires from_agent_id`);
	}
	const senderPeer = await findLocalPeerForAgent(ctx, input.from_agent_id);
	if (!senderPeer) {
		throw new Error(`peer-chat startConversation: no /peer record for sender agent ${input.from_agent_id}`);
	}
	const recipientAgentId = String(peer.identity_pubkey).slice("local:".length);
	const mirror_id = newConversationId();

	const ownerConv: Conversation = {
		id: conversation_id,
		peer_identity_pubkey: peer.identity_pubkey,
		peer_display_name: peer.display_name,
		peer_object_id: peer.peer_id,
		goal: input.goal.trim(),
		status: "active",
		started_at: now,
		started_by_agent_id: input.from_agent_id,
		owner_agent_id: input.from_agent_id,
		mirror_conversation_id: mirror_id,
		hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
		messages: [],
		last_message_at: 0,
		unread_count: 0,
	};
	state.conversations[conversation_id] = ownerConv;
	appendMessageToConversation(state, ownerConv, {
		msg_id, conversation_id, direction: "out", kind: "text", in_reply_to: null, body: input.text, sent_at: now,
	});

	const mirrorConv: Conversation = {
		id: mirror_id,
		peer_identity_pubkey: senderPeer.identity_pubkey,
		peer_display_name: senderPeer.display_name,
		peer_object_id: senderPeer.peer_id,
		goal: input.goal.trim(),
		status: "active",
		started_at: now,
		started_by_agent_id: input.from_agent_id,
		owner_agent_id: recipientAgentId,
		mirror_conversation_id: conversation_id,
		hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
		messages: [],
		last_message_at: 0,
		unread_count: 0,
	};
	state.conversations[mirror_id] = mirrorConv;
	appendMessageToConversation(state, mirrorConv, {
		msg_id, conversation_id: mirror_id, direction: "in", kind: "text", in_reply_to: null, body: input.text, sent_at: now,
	});

	await persistIfChanged(state, ctx);
	void maybeAutoTrigger(ctx, mirror_id);
	return { conversation_id, mirror_conversation_id: mirror_id, msg_id };
}

// ── send: continue an existing active conversation ────────────────

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
		throw new Error("peer-chat send: `conversation_id` is required. Use startConversation to begin a new thread.");
	}
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat send: conversation ${input.conversation_id} not found`);
	if (conv.status !== "active") {
		throw new Error(`peer-chat send: conversation ${input.conversation_id} is ${conv.status} — start a new one to continue.`);
	}

	const isLocalTarget = String(conv.peer_identity_pubkey).startsWith("local:");
	if (!isLocalTarget) {
		throw new Error(`peer-chat send: conversation ${input.conversation_id} is cross-machine. Cross-machine peer-chat is not available — the Hyperswarm transport was removed. Wire the Discord transport (step 2) before continuing.`);
	}
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const sent_at = Date.now();

	if (!input.from_agent_id) throw new Error(`peer-chat send: local conversation requires from_agent_id`);
	if (conv.owner_agent_id && conv.owner_agent_id !== input.from_agent_id) {
		throw new Error(`peer-chat send: conversation ${input.conversation_id} is owned by ${conv.owner_agent_id}, not ${input.from_agent_id}`);
	}
	const senderResult = appendMessageToConversation(state, conv, {
		msg_id, conversation_id: conv.id, direction: "out", kind: "text",
		in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
	});

	const mirrorId = conv.mirror_conversation_id;
	const mirror = mirrorId ? getConversation(state, mirrorId) : null;
	let mirrorResult: { pausedNow: boolean } = { pausedNow: false };
	if (mirror) {
		mirrorResult = appendMessageToConversation(state, mirror, {
			msg_id, conversation_id: mirror.id, direction: "in", kind: "text",
			in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
		});
		if (conv.status !== "active" && mirror.status === "active") {
			mirror.status = conv.status;
			if (conv.status === "paused") mirror.paused_at = sent_at;
		}
		if (mirror.status !== "active" && conv.status === "active") {
			conv.status = mirror.status;
			if (mirror.status === "paused") conv.paused_at = sent_at;
		}
	}

	await persistIfChanged(state, ctx);
	if (mirror && mirror.status === "active") void maybeAutoTrigger(ctx, mirror.id);
	if (senderResult.pausedNow) await notifyPauseForReview(ctx, conv);
	else if (mirrorResult.pausedNow && mirror) await notifyPauseForReview(ctx, mirror);
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
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat endConversation: conversation ${input.conversation_id} not found`);
	if (conv.status === "done") return { ok: true }; // idempotent
	const now = Date.now();
	const reason = (input.reason ?? "").toString().slice(0, 200) || "no reason given";
	conv.status = "done";
	conv.ended_at = now;
	conv.ended_reason = reason;
	conv.ended_by_agent_id = input.from_agent_id ?? conv.owner_agent_id;
	state.conversations[conv.id] = conv;

	// Same-machine mirror: closing one side closes the linked one too.
	if (conv.mirror_conversation_id) {
		const mirror = getConversation(state, conv.mirror_conversation_id);
		if (mirror && mirror.status !== "done") {
			mirror.status = "done";
			mirror.ended_at = now;
			mirror.ended_reason = reason;
			mirror.ended_by_agent_id = conv.ended_by_agent_id;
			state.conversations[mirror.id] = mirror;
		}
	}

	await persistIfChanged(state, ctx);
	return { ok: true };
}

// ── resumeConversation: user re-greenlights a paused thread ───────

interface ResumeConversationInput {
	conversation_id: string;
}

async function doResumeConversation(ctx: ProgramContext, input: ResumeConversationInput): Promise<{ ok: true; new_hop_cap: number }> {
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat resumeConversation: `conversation_id` is required");
	}
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat resumeConversation: conversation ${input.conversation_id} not found`);
	if (conv.status === "done") {
		throw new Error("peer-chat resumeConversation: conversation is done — start a new one to continue.");
	}
	// Extend the hop cap so the next pause fires PAUSE_FOR_REVIEW_AT_HOPS messages from here.
	conv.hop_cap = (conv.messages.length) + PAUSE_FOR_REVIEW_AT_HOPS;
	conv.status = "active";
	conv.resumed_count = (conv.resumed_count ?? 0) + 1;
	conv.paused_at = undefined;
	state.conversations[conv.id] = conv;

	// Mirror gets the same treatment.
	if (conv.mirror_conversation_id) {
		const mirror = getConversation(state, conv.mirror_conversation_id);
		if (mirror) {
			mirror.hop_cap = (mirror.messages.length) + PAUSE_FOR_REVIEW_AT_HOPS;
			mirror.status = "active";
			mirror.resumed_count = (mirror.resumed_count ?? 0) + 1;
			mirror.paused_at = undefined;
			state.conversations[mirror.id] = mirror;
		}
	}
	await persistIfChanged(state, ctx);
	// Nudge whoever was waiting on a reply (the side whose latest message is incoming).
	const lastOwner = conv.messages[conv.messages.length - 1];
	if (lastOwner?.direction === "in" && conv.status === "active") void maybeAutoTrigger(ctx, conv.id);
	const mirrorConv = conv.mirror_conversation_id ? getConversation(state, conv.mirror_conversation_id) : null;
	if (mirrorConv) {
		const lastMirror = mirrorConv.messages[mirrorConv.messages.length - 1];
		if (lastMirror?.direction === "in" && mirrorConv.status === "active") void maybeAutoTrigger(ctx, mirrorConv.id);
	}
	return { ok: true, new_hop_cap: conv.hop_cap };
}

// ── Auto-trigger ─────────────────────────────────────────────────
// When an inbound message lands in a still-active local conversation,
// nudge the recipient's /agent ask asynchronously so the conversation
// flows. Fire-and-forget; failures stay out of the caller's path.
async function maybeAutoTrigger(ctx: ProgramContext, conversation_id: string): Promise<void> {
	try {
		const conv = getConversation(ctx.state, conversation_id);
		if (!conv || conv.status !== "active" || !conv.owner_agent_id) return;
		const last = conv.messages[conv.messages.length - 1];
		if (!last || last.direction !== "in") return; // only react to incoming
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
		ctx.print?.(dim(`  [peer-chat] auto-trigger failed for conv ${conversation_id}: ${err?.message ?? err}`));
	}
}

// ── Read actions ─────────────────────────────────────────────────

interface ListConversationsInput {
	peer_id?: string;
	identity_pubkey?: string;
	status?: ConversationStatus;
	from_agent_id?: string;        // bound by tool; filters to the asking agent's conversations
	include_other_perspectives?: boolean;  // default false — hide mirror entries
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
			if (i.from_agent_id && !i.include_other_perspectives) {
				// Show only conversations this agent owns. Mirrors owned by
				// other local agents (peer_identity_pubkey == local:<me>)
				// belong to the OTHER side.
				if (c.owner_agent_id && c.owner_agent_id !== i.from_agent_id) return false;
				const ownLocal = `local:${i.from_agent_id}`.toLowerCase();
				if (c.peer_identity_pubkey.toLowerCase() === ownLocal) return false;
			}
			return true;
		})
		.sort((a, b) => b.last_message_at - a.last_message_at)
		.map((c) => ({
			conversation_id: c.id,
			peer_identity_pubkey: c.peer_identity_pubkey,
			peer_display_name: c.peer_display_name,
			peer_object_id: c.peer_object_id,
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
	if (input.conversation_id) {
		conv = conversations[input.conversation_id] ?? null;
	} else if (input.identity_pubkey || input.peer_id) {
		// Find the most recent active conversation owned by this agent for the requested peer.
		const matches = Object.values(conversations).filter((c) => {
			if (input.identity_pubkey && c.peer_identity_pubkey.toLowerCase() !== input.identity_pubkey.toLowerCase()) return false;
			if (input.peer_id && c.peer_object_id !== input.peer_id) return false;
			if (input.from_agent_id && c.owner_agent_id && c.owner_agent_id !== input.from_agent_id) return false;
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
}
async function doMarkRead(ctx: ProgramContext, input: MarkReadInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let conv: Conversation | null = null;
	if (input.conversation_id) conv = conversations[input.conversation_id] ?? null;
	else {
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
		print(dim(`    conversations: ${s.conversations}`));
		print(dim(`    messages in:   ${s.messages_in}`));
		print(dim(`    messages out:  ${s.messages_out}`));
		print(dim(`    unread:        ${s.unread}`));
		return;
	}
	if (cmd === "send") {
		const peerRef = args[0];
		const text = args.slice(1).join(" ");
		if (!peerRef || !text) { print(red("Usage: /peer-chat send <peer-name|identity-pubkey> <message...>")); return; }
		try {
			const isHex = /^[0-9a-fA-F]{64}$/.test(peerRef);
			const ref = isHex ? { identity_pubkey: peerRef } : { display_name: peerRef };
			// Find an active conversation with this peer; if none, start one.
			const convs = await doListConversations(ctx, { ...ref, status: "active" });
			let conversation_id = (convs[0] as any)?.conversation_id;
			if (!conversation_id) {
				const r = await doStartConversation(ctx, { ...ref, goal: "(CLI message from human)", text });
				print(green(`started conversation ${r.conversation_id}, sent: ${r.msg_id}`));
				return;
			}
			const r = await doSend(ctx, { conversation_id, text });
			print(green(`sent: ${r.msg_id}`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}
	if (cmd === "read") {
		const peerRef = args[0];
		if (!peerRef) { print(red("Usage: /peer-chat read <peer-name|identity-pubkey>")); return; }
		const isHex = /^[0-9a-fA-F]{64}$/.test(peerRef);
		const msgs = await doListMessages(ctx, isHex ? { identity_pubkey: peerRef } : (async () => {
			// Resolve display_name to identity for read
			const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
			const m = (all || []).find((p) => (p.display_name ?? "").toLowerCase() === peerRef.toLowerCase());
			return m?.identity_pubkey ? { identity_pubkey: m.identity_pubkey } : {};
		})() as any);
		if (msgs.length === 0) { print(dim("(no messages)")); return; }
		for (const m of msgs) {
			const ts = new Date(m.sent_at).toLocaleTimeString();
			const tag = m.direction === "in" ? cyan("◀ them") : green("you ▶");
			const body = m.kind === "text" ? String(m.body) : `[${m.kind}] ${JSON.stringify(m.body)}`;
			print(`  ${dim(ts)}  ${tag}  ${body}`);
		}
		return;
	}
	if (cmd === "list") {
		const convs = await doListConversations(ctx, {});
		if (convs.length === 0) { print(dim("(no conversations yet)")); return; }
		for (const c of convs) {
			const age = Math.round((Date.now() - c.last_message_at) / 1000);
			const unread = c.unread_count > 0 ? red(` (${c.unread_count} unread)`) : "";
			const statusTag = c.status === "active" ? green("●") : c.status === "done" ? dim("✓") : yellow("⌛");
			print(`  ${statusTag} ${cyan(c.peer_display_name)}  ${dim(`"${(c.goal || "").slice(0, 40)}"`)}  ${dim(`${c.message_count} msgs, ${age}s ago`)}${unread}`);
		}
		return;
	}
	print([
		bold("  peer-chat") + dim(" — agent-to-agent messaging (same-daemon only until Discord transport lands)"),
		`    ${cyan("/peer-chat list")}                          list conversations`,
		`    ${cyan("/peer-chat read")} ${dim("<peer>")}                    read a conversation`,
		`    ${cyan("/peer-chat send")} ${dim("<peer> <message...>")}        send a message`,
		`    ${cyan("/peer-chat status")}                        message counters`,
		dim("    <peer> may be a display_name (e.g. 'glon') or a 64-hex identity_pubkey."),
		dim("    Trust gate: only peers at trust ≥ trusted can be reached or be received from."),
	].join("\n"));
	void yellow;
};

// ── Actor ───────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ conversations: {} }),
	onCreate: async (ctx) => {
		await restoreState(ctx.state, ctx);
	},
	typedActions: {
		startConversation: {
			description: "Start a new goal-driven conversation with a peer. Requires goal (1-280 chars) and an opening text message. Returns conversation_id; subsequent messages use send with that id. Either side can call endConversation to close.",
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
			description: "Send a message into an existing active conversation. Requires conversation_id from a prior startConversation. Fails if the conversation is done. If paused (waiting for human review), the message is rejected until the user resumes.",
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
			description: "Mark a conversation as done. One side calling this closes it for both. Idempotent on already-closed conversations.",
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
			description: "Resume a paused conversation. Called by the human user after reviewing whether the agents should keep going. Extends the hop cap by PAUSE_FOR_REVIEW_AT_HOPS messages and re-fires any pending auto-trigger.",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: { conversation_id: { type: "string" } },
			},
			handler: async (ctx, input: ResumeConversationInput) => doResumeConversation(ctx, input),
		},
		listConversations: {
			description: "List conversations, sorted by last_message_at desc. Pass from_agent_id to filter to your own perspective (drops mirror entries for sibling agents).",
			inputSchema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
					from_agent_id: { type: "string" },
					include_other_perspectives: { type: "boolean" },
				},
			},
			handler: async (ctx, input: ListConversationsInput) => doListConversations(ctx, input ?? {}),
		},
		listMessages: {
			description: "Return messages in a conversation. Prefer conversation_id; peer_id/identity_pubkey resolves to the most recent matching conversation.",
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
			description: "Reset unread_count for a conversation to 0.",
			inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, peer_id: { type: "string" }, identity_pubkey: { type: "string" } } },
			handler: async (ctx, input: MarkReadInput) => doMarkRead(ctx, input ?? {}),
		},
		status: {
			description: "Return counters: conversations (total/active/done/paused), messages in/out, unread.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doStatus(ctx),
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = { doStartConversation, doSend, doEndConversation, doResumeConversation, doListConversations, doListMessages };
