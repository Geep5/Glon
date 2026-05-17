import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);

  const refs = await store.list("program") as any[];
  for (const ref of refs) {
    const state = await store.get(ref.id) as any;
    const p = state?.fields?.prefix?.stringValue ?? state?.fields?.prefix;
    if (p === "/holdfast") {
      console.log("Program ID:", ref.id);
      console.log("Full state:", JSON.stringify(state, null, 2));
      break;
    }
  }
}

main().catch(console.error);
