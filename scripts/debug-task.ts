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
    if (p === "/task") {
      console.log("Program ID:", ref.id);
      const manifest = state?.fields?.manifest?.mapValue?.entries ?? state?.fields?.manifest;
      console.log("Entry:", manifest?.entry?.stringValue ?? manifest?.entry);
      const modules = manifest?.modules?.mapValue?.entries ?? manifest?.modules;
      if (modules) {
        for (const [k, v] of Object.entries(modules)) {
          console.log("  module:", k, "=>", typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40));
        }
      }
      break;
    }
  }
}

main().catch(console.error);
