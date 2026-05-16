import { createClient } from "rivetkit/client";
import type { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

async function main() {
  const tokens = await store.list("chain.token");
  console.log("Tokens:", tokens.length);
  for (const t of tokens.slice(0, 3)) {
    console.log(" ", t.id, t.typeKey);
  }
  
  const buckets = await store.list("chain.coin.bucket");
  console.log("Buckets:", buckets.length);
  
  const offers = await store.list("chain.coin.offer");
  console.log("Offers:", offers.length);
  
  for (const t of tokens.slice(0, 3)) {
    try {
      const holders = await store.coinHolders(t.id);
      console.log(`Token ${t.id}: ${holders.length} holders`);
      for (const h of holders) {
        console.log(`  ${h.pubkey.slice(0,16)}...: ${h.balance}`);
      }
    } catch(e: any) {
      console.log(`Token ${t.id}: error - ${e.message}`);
    }
  }
}

main().catch(console.error);
