import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const client = createClient<typeof app>(resolveEndpoint());
  
  // Build a valid signed change to push
  const tokenId = "90c86a5aa43e4a5db979e659";
  
  // Get token state
  const r = await fetch("http://localhost:6430/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "/token", action: "state", args: [tokenId] }),
  });
  const state = (await r.json()).result;
  console.log("Token state:", state.name, state.totalSupply);
  
  // Build a change
  const { changeB64 } = await (await fetch("http://localhost:6430/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      prefix: "/token", 
      action: "buildOp", 
      args: [{
        tokenId,
        parentIds: [],
        timestamp: Date.now(),
        author: "test",
        op: { kind: "Transfer", to: "929a2112b43bd4467d5d7575895bc8d91a7b902530c3c60b087a59a419a73157", amount: "1" },
        signerPubkeyHex: "7cf3f216de262abd34460c1c7bb2823f4b7b41f6e47a793ddca02f3c01075196",
        blockId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      }] 
    }),
  })).json();
  
  console.log("Built change");
  
  // Sign it
  const { changeB64: signedB64 } = await (await fetch("http://localhost:6430/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      prefix: "/wallet", 
      action: "signChange", 
      args: [{
        name: "figgies_owner",
        changeB64,
        nonce: 1,
        fee: 1,
      }] 
    }),
  })).json();
  
  console.log("Signed change");
  
  // Push
  try {
    const objActor = client.objectActor.getOrCreate([tokenId]);
    await objActor.pushChanges(signedB64);
    console.log("Push succeeded!");
  } catch (e: any) {
    console.error("Push failed:");
    console.error("Message:", e.message);
    console.error("Stack:", e.stack);
    if (e.cause) {
      console.error("Cause:", e.cause);
    }
  }
}

main();
