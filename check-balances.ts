import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";

const client = createClient<typeof app>(resolveEndpoint());
const store = client.storeActor.getOrCreate(["root"]);

async function main() {
  const tokens = await store.list("chain.token");
  console.log("Tokens:", tokens.length);
  for (const t of tokens) {
    const obj = await store.get(t.id);
    const name = obj?.fields?.name?.stringValue || "?";
    const symbol = obj?.fields?.symbol?.stringValue || "?";
    console.log(`  ${t.id} - ${name} (${symbol})`);
  }
  
  const buckets = await store.list("chain.coin.bucket");
  console.log("\nBuckets:", buckets.length);
  
  console.log("\n--- Balances ---");
  for (const t of tokens) {
    try {
      const holders = await (store as any).coinHolders(t.id);
      if (holders.length > 0) {
        const obj = await store.get(t.id);
        const name = obj?.fields?.name?.stringValue || "?";
        console.log(`Token ${name}: ${holders.length} holders`);
        for (const h of holders) {
          console.log(`  ${h.pubkey.slice(0, 16)}...: ${h.balance}`);
        }
      }
    } catch (e: any) {
      console.log(`Token ${t.id}: error - ${e.message}`);
    }
  }
}

main().catch(console.error);
