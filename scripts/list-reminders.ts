import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const refs = await store.list("reminder") as { id: string }[];
  console.log(`reminder count: ${refs.length}`);
  for (const r of refs) {
    const o = await store.get(r.id) as any;
    console.log("\n---", r.id);
    for (const [k, v] of Object.entries(o.fields ?? {})) {
      const val: any = v;
      const s = val?.stringValue ?? val?.intValue ?? val?.boolValue ?? JSON.stringify(val).slice(0, 200);
      console.log(`  ${k}: ${typeof s === "string" ? s.slice(0, 200) : s}`);
    }
    console.log(`  blocks: ${(o.blocks ?? []).length}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
