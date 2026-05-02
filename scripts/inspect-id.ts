import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const id = process.argv[2];
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const o = await store.get(id) as any;
  console.log("typeKey:", o?.typeKey);
  console.log("fields:");
  for (const [k, v] of Object.entries(o?.fields ?? {})) {
    const val: any = v;
    const s = val?.stringValue ?? val?.intValue ?? JSON.stringify(val).slice(0, 200);
    console.log(`  ${k}: ${s}`);
  }
  console.log("blocks:", (o?.blocks ?? []).length);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
