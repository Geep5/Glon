/**
 * Live Figgies Transfer Demo
 *
 * Demonstrates a real on-chain token transfer:
 * 1. Shows current balances
 * 2. Creates a new recipient wallet key
 * 3. Owner sends 50 FIG to recipient
 * 4. Recipient sends 10 FIG back
 * 5. Shows final balances + anchor chain status
 *
 * Usage: GLON_DATA=... npx tsx scripts/live-transfer-demo.ts
 */

import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

const ENDPOINT = resolveEndpoint();
const TOKEN_ID = "90c86a5aa43e4a5db979e659";

async function main() {
	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);
	const fs = await import("node:fs");

	// Import token handler internals
	const tokenModule = await import("../src/programs/handlers/token.js");
	const { __test: tokenTest } = tokenModule;
	const { buildOpChange, replayState } = tokenTest;

	// Import wallet handler internals
	const { __test: walletTest } = await import("../src/programs/handlers/wallet.js");
	const { doNew, doShow, doSignChange } = walletTest;

	// Import proto + crypto
	const { encodeChange } = await import("../src/proto.js");
	const { hexDecode } = await import("../src/crypto.js");

	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║     Live Figgies Transfer Demo                               ║");
	console.log("║     Token: 90c86a5aa43e4a5db979e659                          ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");

	// ── Step 1: Get owner key ─────────────────────────────────────
	console.log("\n▶ Step 1: Load owner key");
	const ownerInfo = doShow("figgies_owner");
	if (!ownerInfo) throw new Error("figgies_owner key not found");
	const ownerPubkey = ownerInfo.pubkey;
	console.log("  owner", ownerPubkey.slice(0, 8) + "…" + ownerPubkey.slice(-8));

	// ── Step 2: Create recipient key ──────────────────────────────
	console.log("\n▶ Step 2: Create recipient key");
	let recipientInfo: { pubkey: string };
	try {
		recipientInfo = doNew("demo_recipient", Date.now());
	} catch {
		recipientInfo = doShow("demo_recipient")!;
	}
	const recipientPubkey = recipientInfo.pubkey;
	console.log("  recipient", recipientPubkey.slice(0, 8) + "…" + recipientPubkey.slice(-8));

	// ── Step 3: Show current state ────────────────────────────────
	console.log("\n▶ Step 3: Token state before");
	const tokenObj = await store.get(TOKEN_ID) as any;
	const stateBefore = replayState(tokenObj.fields ?? {}, tokenObj.blocks ?? []);
	console.log("  name", `${stateBefore.name} (${stateBefore.symbol})`);
	console.log("  supply", stateBefore.totalSupply.toString());
	console.log("  owner balance", (stateBefore.balances.get(ownerPubkey) ?? 0n).toString());
	console.log("  recipient balance", (stateBefore.balances.get(recipientPubkey) ?? 0n).toString());

	// ── Step 4: Owner sends 50 FIG to recipient ───────────────────
	console.log("\n▶ Step 4: Owner sends 50 FIG → recipient");
	const change1 = buildOpChange({
		tokenId: TOKEN_ID,
		parentIds: (tokenObj.headIds ?? []).map((h: string) => hexDecode(h)),
		timestamp: Date.now(),
		author: "demo-transfer",
		op: { kind: "Transfer", to: recipientPubkey, amount: "50" },
		signerPubkeyHex: ownerPubkey,
		blockId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
	});
	const changeB64_1 = Buffer.from(encodeChange(change1)).toString("base64");

	const { changeB64: signedB64_1 } = doSignChange({
		name: "figgies_owner",
		changeB64: changeB64_1,
		nonce: 1,
		fee: 1,
	});

	const objActor = client.objectActor.getOrCreate([TOKEN_ID]);
	await objActor.pushChanges(signedB64_1);
	console.log("  ✅ Transferred 50 FIG");

	// ── Step 5: Show mid state ────────────────────────────────────
	console.log("\n▶ Step 5: State after first transfer");
	const tokenObj2 = await store.get(TOKEN_ID) as any;
	const stateMid = replayState(tokenObj2.fields ?? {}, tokenObj2.blocks ?? []);
	console.log("  owner balance", (stateMid.balances.get(ownerPubkey) ?? 0n).toString());
	console.log("  recipient balance", (stateMid.balances.get(recipientPubkey) ?? 0n).toString());

	// ── Step 6: Recipient sends 10 FIG back ───────────────────────
	console.log("\n▶ Step 6: Recipient sends 10 FIG → owner");
	const change2 = buildOpChange({
		tokenId: TOKEN_ID,
		parentIds: (tokenObj2.headIds ?? []).map((h: string) => hexDecode(h)),
		timestamp: Date.now(),
		author: "demo-transfer",
		op: { kind: "Transfer", to: ownerPubkey, amount: "10" },
		signerPubkeyHex: recipientPubkey,
		blockId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
	});
	const changeB64_2 = Buffer.from(encodeChange(change2)).toString("base64");

	const { changeB64: signedB64_2 } = doSignChange({
		name: "demo_recipient",
		changeB64: changeB64_2,
		nonce: 1,
		fee: 1,
	});

	await objActor.pushChanges(signedB64_2);
	console.log("  ✅ Transferred 10 FIG back");

	// ── Step 7: Show final state ──────────────────────────────────
	console.log("\n▶ Step 7: Final state");
	const tokenObj3 = await store.get(TOKEN_ID) as any;
	const stateFinal = replayState(tokenObj3.fields ?? {}, tokenObj3.blocks ?? []);
	console.log("  owner balance", (stateFinal.balances.get(ownerPubkey) ?? 0n).toString());
	console.log("  recipient balance", (stateFinal.balances.get(recipientPubkey) ?? 0n).toString());

	// ── Step 8: Verify on anchor chain ────────────────────────────
	console.log("\n▶ Step 8: Anchor chain status");
	const anchorRes = await fetch("http://localhost:6430/dispatch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prefix: "/anchor", action: "getLatest", args: [] }),
	});
	const anchorData = (await anchorRes.json()) as any;
	if (anchorData.ok) {
		const latest = anchorData.result;
		console.log("  latest anchor", `height ${latest.height}, ${latest.id.slice(0, 8)}…`);
		console.log("  merkle root", latest.root.slice(0, 16) + "…");
	} else {
		console.log("  (anchor query failed)", anchorData.error);
	}

	console.log("\n✅ Demo complete!");
}

main().catch((err) => {
	console.error("❌", err.message);
	process.exit(1);
});
