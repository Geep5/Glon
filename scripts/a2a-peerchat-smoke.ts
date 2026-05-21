// End-to-end smoke test for Discord-mediated peer-chat between two
// LOCAL agents on the same daemon. Mocks /peer with two pre-trusted
// agent records, then drives peer-chat startConversation → /discord
// pollA2A → handleA2A → reply → poll → verify.
//
// Requires .env populated with DISCORD_BOT_TOKEN + GLON_A2A_DISCORD_GUILD.
//
// Run: npx tsx scripts/a2a-peerchat-smoke.ts

import "../src/env.js";
import { randomUUID } from "node:crypto";

const discordModule: any = await import("../src/programs/handlers/discord.js");
const peerChatModule: any = await import("../src/programs/handlers/peer-chat.js");
const discordProgram = discordModule.default;
const peerChatProgram = peerChatModule.default;

// Two local agents. Each has:
//   - peer_id: the /peer record id (would be an opaque store id; pick something readable)
//   - agent_object_id: the local rivetkit /agent id (passed as from_agent_id by tools)
//   - agent_uuid: the globally unique v4 carried in envelopes
//   - display_name
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
	{
		id: MIKEY.peer_id,
		display_name: MIKEY.display_name,
		kind: "agent",
		trust_level: "trusted",
		agent_uuid: MIKEY.agent_uuid,
		agent_object_id: MIKEY.agent_object_id,
	},
	{
		id: TARZAN.peer_id,
		display_name: TARZAN.display_name,
		kind: "agent",
		trust_level: "trusted",
		agent_uuid: TARZAN.agent_uuid,
		agent_object_id: TARZAN.agent_object_id,
	},
];

const peerChatState: Record<string, any> = { conversations: {} };
const discordState: Record<string, any> = {
	botUserId: "",
	dmChannelByPeer: {},
	watermarks: {},
	a2aWatermarks: {},
	a2aCategoryByGuild: {},
	a2aPairChannel: {},
};

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
	if (typed) {
		const inputObj = input === undefined ? {} : input;
		return await typed.handler(ctx, inputObj);
	}
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
	if (prefix === "/discord") {
		return await callActor(discordProgram, action, input, discordState);
	}
	if (prefix === "/peer-chat") {
		return await callActor(peerChatProgram, action, input, peerChatState);
	}
	if (prefix === "/agent") {
		// Auto-trigger calls /agent ask; no-op since we don't have an LLM here.
		return { finalText: "[mock agent — no LLM in smoke test]" };
	}
	if (prefix === "/user-chat") return null;
	throw new Error(`smoke dispatch: unknown program ${prefix}`);
}

function dump(label: string, val: unknown) {
	console.log(`\n=== ${label} ===`);
	console.log(JSON.stringify(val, null, 2));
}

async function main() {
	console.log(`[smoke] Mikey (${MIKEY.agent_uuid.slice(0, 8)}…) opens a conversation with Tarzan (${TARZAN.agent_uuid.slice(0, 8)}…)…`);
	const start = await dispatchProgram("/peer-chat", "startConversation", [{
		from_agent_id: MIKEY.agent_object_id,
		display_name: "Tarzan",
		goal: "Discord A2A smoke test (agent_uuid edition)",
		text: "Hey Tarzan! Riding the new agent_uuid envelope through Discord.",
	}]);
	dump("startConversation result", start);

	const conversationId = (start as any).conversation_id;
	console.log("\n[smoke] Letting Discord index the message…");
	await new Promise((r) => setTimeout(r, 1500));

	console.log("[smoke] Forcing /discord pollA2A to ingest…");
	const poll1 = await dispatchProgram("/discord", "pollA2A", [{}]);
	dump("pollA2A #1", poll1);

	const tarzanView = await dispatchProgram("/peer-chat", "listConversations", [{ from_agent_id: TARZAN.agent_object_id }]);
	dump("Tarzan's conversations after poll #1", tarzanView);
	if (!Array.isArray(tarzanView) || tarzanView.length === 0) {
		console.error("[smoke] FAIL: Tarzan did not receive Mikey's opening message");
		process.exit(1);
	}
	if (tarzanView[0].conversation_id !== conversationId) {
		console.error(`[smoke] FAIL: Tarzan's conv id ${tarzanView[0].conversation_id} != Mikey's ${conversationId}`);
		process.exit(2);
	}

	console.log("\n[smoke] Tarzan replies to Mikey…");
	const reply = await dispatchProgram("/peer-chat", "send", [{
		from_agent_id: TARZAN.agent_object_id,
		conversation_id: conversationId,
		text: "Got it — Tarzan here. agent_uuid renames work end-to-end.",
	}]);
	dump("Tarzan send result", reply);

	console.log("\n[smoke] Letting Discord index Tarzan's reply…");
	await new Promise((r) => setTimeout(r, 1500));

	const poll2 = await dispatchProgram("/discord", "pollA2A", [{}]);
	dump("pollA2A #2", poll2);

	const mikeyMessages = await dispatchProgram("/peer-chat", "listMessages", [{
		from_agent_id: MIKEY.agent_object_id,
		conversation_id: conversationId,
	}]);
	dump("Mikey's messages after poll #2", mikeyMessages);

	const gotReplyOnMikey = Array.isArray(mikeyMessages) && mikeyMessages.some((m: any) => m.direction === "in");
	if (!gotReplyOnMikey) {
		console.error("[smoke] FAIL: Mikey never saw Tarzan's reply");
		process.exit(3);
	}

	console.log("\n[smoke] OK — full Mikey ↔ Tarzan round-trip via Discord works.");
	console.log(`[smoke] Conversation id: ${conversationId}`);
	console.log(`[smoke] Channel id: ${start.discord_channel_id}`);
}

main().catch((e) => {
	console.error("[smoke] uncaught:", e);
	process.exit(99);
});
