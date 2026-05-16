import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);

async function main() {
  const store = client.storeActor.getOrCreate(["root"]);
  const tokens = await store.list("chain.token");
  
  console.log("=== GLON COIN BALANCES ===\n");
  
  for (const t of tokens) {
    const obj = await store.get(t.id);
    const name = obj?.fields?.name?.stringValue || "?";
    const symbol = obj?.fields?.symbol?.stringValue || "?";
    const holders = await (store as any).coinHolders(t.id);
    
    if (holders.length > 0) {
      console.log(`Token: ${name} (${symbol}) — ID: ${t.id}`);
      for (const h of holders) {
        console.log(`  ${h.pubkey.slice(0, 16)}... : ${h.balance}`);
      }
      console.log();
    }
  }
}

main().catch(console.error);
