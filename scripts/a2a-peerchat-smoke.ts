// End-to-end smoke test for thread-based A2A. Mocks /peer with two
// pre-trusted agent records, drives:
//   Mikey peer_conversation_start  →  /discord ensurePairChannel + ensureConversationThread + postToThread
//   /discord pollA2A               →  /peer-chat handleA2A (Tarzan's loop fires — mocked)
//   Tarzan peer_message_send       →  postToThread
//   /discord pollA2A               →  /peer-chat handleA2A (Mikey's loop fires — mocked)
//   Mikey peer_conversation_done   →  archiveThread (locks the thread)
//
// Verifies that handleA2A was called for each agent at the expected step.
// Requires .env populated with DISCORD_BOT_TOKEN + GLON_A2A_DISCORD_GUILD.

import "../src/env.js";
import { randomUUID } from "node:crypto";

const discordModule: any = await import("../src/programs/handlers/discord.js");
const peerChatModule: any = await import("../src/programs/handlers/peer-chat.js");
const discordProgram = discordModule.default;
const peerChatProgram = peerChatModule.default;

const MIKEY = {
	peer_id: "peer-mikey",
	agent_object_id: "agent-mikey-obj",
	agent_uuid: randomUUID(),
	display_name: "Mikey",
};
const TARZAN = {
	peer_id: "peer-tarzan",
	agent_object_id: "agent-tarzan-obj",
	agent_uuid: randomUUID(),
	display_name: "Tarzan",
};

const peers: any[] = [
	{ id: MIKEY.peer_id, display_name: MIKEY.display_name, kind: "agent", trust_level: "trusted", agent_uuid: MIKEY.agent_uuid, agent_object_id: MIKEY.agent_object_id },
	{ id: TARZAN.peer_id, display_name: TARZAN.display_name, kind: "agent", trust_level: "trusted", agent_uuid: TARZAN.agent_uuid, agent_object_id: TARZAN.agent_object_id },
];

const peerChatState: Record<string, any> = {};
const discordState: Record<string, any> = {
	botUserId: "",
	dmChannelByPeer: {},
	watermarks: {},
	a2aThreadWatermarks: {},
	a2aCategoryByGuild: {},
	a2aPairChannel: {},
};

// Track which agent's loop got auto-triggered (handleA2A → /agent ask)
const triggered: Array<{ agent_object_id: string; promptStart: string }> = [];

function makeCtx(state: Record<string, any>): any {
	return {
		state,
		print: (s: string) => console.log("  " + s),
		dispatchProgram,
		stringVal: (v: any) => ({ stringValue: String(v) }),
		objectActor: () => ({ setField: async () => {} }),
		store: { get: async () => null },
		programId: "smoke-test",
	};
}

async function callActor(program: any, action: string, input: any, state: Record<string, any>) {
	const def = program.actor;
	const typed = def.typedActions?.[action];
	const ctx = makeCtx(state);
	if (typed) return await typed.handler(ctx, input === undefined ? {} : input);
	const fn = def.actions?.[action];
	if (!fn) throw new Error(`no action ${action} on program`);
	return await fn(ctx, input);
}

async function dispatchProgram(prefix: string, action: string, args: any[]): Promise<any> {
	const input = args?.[0];
	if (prefix === "/peer") {
		if (action === "list") return peers;
		if (action === "get") {
			const id = typeof input === "string" ? input : input?.peer_id;
			return peers.find((p) => p.id === id) ?? null;
		}
	}
	if (prefix === "/discord") return await callActor(discordProgram, action, input, discordState);
	if (prefix === "/peer-chat") return await callActor(peerChatProgram, action, input, peerChatState);
	if (prefix === "/agent" && action === "ask") {
		const [agent_object_id, prompt] = args;
		triggered.push({ agent_object_id, promptStart: prompt.slice(0, 80) });
		return { finalText: "[mock — no LLM]" };
	}
	if (prefix === "/user-chat") return null;
	throw new Error(`smoke dispatch: unknown ${prefix}.${action}`);
}

function dump(label: string, val: unknown) {
	console.log(`\n=== ${label} ===`);
	console.log(JSON.stringify(val, null, 2));
}

async function main() {
	console.log(`[smoke] Mikey (${MIKEY.agent_uuid.slice(0, 8)}…) → Tarzan (${TARZAN.agent_uuid.slice(0, 8)}…)`);
	const start = await dispatchProgram("/peer-chat", "startConversation", [{
		from_agent_id: MIKEY.agent_object_id,
		display_name: "Tarzan",
		goal: "Discord threads smoke test",
		text: "Hey Tarzan, this conversation is now its own Discord thread.",
	}]);
	dump("startConversation result", start);
	const conversationId = (start as any).conversation_id;

	console.log("\n[smoke] Letting Discord index the message…");
	await new Promise((r) => setTimeout(r, 1500));

	console.log("[smoke] Forcing /discord pollA2A to fire Tarzan's loop…");
	const poll1 = await dispatchProgram("/discord", "pollA2A", [{}]);
	dump("pollA2A #1", poll1);
	const tarzanFired = triggered.some((t) => t.agent_object_id === TARZAN.agent_object_id);
	if (!tarzanFired) {
		console.error("[smoke] FAIL: Tarzan's loop never auto-triggered");
		process.exit(1);
	}

	console.log("\n[smoke] Tarzan replies…");
	const reply = await dispatchProgram("/peer-chat", "send", [{
		from_agent_id: TARZAN.agent_object_id,
		conversation_id: conversationId,
		text: "Got it — Tarzan here. Threads are nice.",
	}]);
	dump("Tarzan send", reply);

	await new Promise((r) => setTimeout(r, 1500));
	console.log("[smoke] Forcing /discord pollA2A to fire Mikey's loop…");
	const poll2 = await dispatchProgram("/discord", "pollA2A", [{}]);
	dump("pollA2A #2", poll2);
	const mikeyFired = triggered.some((t) => t.agent_object_id === MIKEY.agent_object_id);
	if (!mikeyFired) {
		console.error("[smoke] FAIL: Mikey's loop never auto-triggered on reply");
		process.exit(2);
	}

	console.log("\n[smoke] Mikey closes the conversation (locks thread)…");
	await dispatchProgram("/peer-chat", "endConversation", [{
		from_agent_id: MIKEY.agent_object_id,
		conversation_id: conversationId,
		reason: "smoke test complete",
	}]);

	console.log("\n[smoke] listConversations should show this as done (locked)…");
	const convs = await dispatchProgram("/peer-chat", "listConversations", [{
		from_agent_id: MIKEY.agent_object_id,
		include_archived: true,
	}]);
	dump("Mikey's conversations", convs);
	const ours = (convs as any[]).find((c) => c.conversation_id === conversationId);
	if (!ours || ours.status !== "done") {
		console.error(`[smoke] FAIL: expected status=done after endConversation, got ${ours?.status ?? "(missing)"}`);
		process.exit(3);
	}

	console.log("\n[smoke] listMessages from Mikey's perspective…");
	const msgs = await dispatchProgram("/peer-chat", "listMessages", [{
		from_agent_id: MIKEY.agent_object_id,
		conversation_id: conversationId,
		limit: 20,
	}]);
	dump("Mikey's transcript", msgs);
	const inbound = (msgs as any[]).some((m) => m.direction === "in");
	const outbound = (msgs as any[]).some((m) => m.direction === "out");
	if (!inbound || !outbound) {
		console.error(`[smoke] FAIL: expected both inbound and outbound messages in transcript (in=${inbound}, out=${outbound})`);
		process.exit(4);
	}

	console.log("\n[smoke] OK — Mikey ↔ Tarzan over Discord threads works end-to-end");
	console.log(`[smoke] Conversation (thread) id: ${conversationId}`);
}

main().catch((e) => {
	console.error("[smoke] uncaught:", e);
	process.exit(99);
});
