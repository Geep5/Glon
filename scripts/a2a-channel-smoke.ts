// Smoke-test the new A2A channel helpers in /discord against a live guild.
// Loads .env, calls doEnsurePairCategory + doEnsurePairChannel with two
// throwaway identity pubkeys, and prints what landed.

import "../src/env.js";

// Re-import the helpers from the .ts source directly (tsx handles compilation).
// The /discord program doesn't export them, so we hand-roll the same calls
// here against the same internal helpers via dynamic import.
const mod: any = await import("../src/programs/handlers/discord.js");

// Pull the smoke-test helpers off __test if exposed, else re-use the public
// actor.actions surface by constructing a fake context.
const state: Record<string, any> = {};

// Use the public action surface via the actor.
const program = mod.default;
const actions = program.actor?.actions ?? {};

if (!actions.ensurePairCategory || !actions.ensurePairChannel) {
	console.error("ensurePairCategory / ensurePairChannel not on /discord actor — bailing");
	process.exit(1);
}

const ctx = {
	state,
	print: (s: string) => console.log(s),
	dispatchProgram: async () => { throw new Error("not used in smoke test"); },
} as any;

console.log("[smoke] ensuring A2A category…");
const cat = await actions.ensurePairCategory(ctx);
console.log("[smoke] category:", cat);

const idA = "a1b2c3d4e5f6789001020304050607080910111213141516171819202122232425";
const idB = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

console.log("[smoke] ensuring pair channel for two test identities…");
const ch = await actions.ensurePairChannel(ctx, { peer_a_identity_pubkey: idA, peer_b_identity_pubkey: idB });
console.log("[smoke] channel:", ch);

console.log("[smoke] re-running ensurePairChannel — should be idempotent (created:false expected)");
state.a2aPairChannel = {}; // force a fresh list-channels round-trip
const ch2 = await actions.ensurePairChannel(ctx, { peer_a_identity_pubkey: idA, peer_b_identity_pubkey: idB });
console.log("[smoke] channel (2nd call):", ch2);
if (ch2.created) {
	console.error("[smoke] FAIL — second call created a new channel, idempotency broken");
	process.exit(2);
}

console.log("[smoke] reversing arg order — same channel name expected");
const ch3 = await actions.ensurePairChannel(ctx, { peer_a_identity_pubkey: idB, peer_b_identity_pubkey: idA });
console.log("[smoke] channel (reversed args):", ch3);
if (ch3.channel_id !== ch.channel_id) {
	console.error("[smoke] FAIL — channel id differs when arg order is reversed");
	process.exit(3);
}

console.log("[smoke] OK");
