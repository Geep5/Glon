import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const agentId = process.argv[2];
  const prefixes = process.argv.slice(3); // e.g. google_ web_
  if (!agentId || prefixes.length === 0) {
    console.error("Usage: prune-tools.ts <agentId> <prefix1> [prefix2 ...]");
    process.exit(1);
  }
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const obj = await store.get(agentId) as any;
  const toolsField = obj.fields?.tools;
  const entries = toolsField?.mapValue?.entries ?? {};
  const before = Object.keys(entries);
  const after: Record<string, any> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (prefixes.some(p => k.startsWith(p))) { dropped++; continue; }
    after[k] = v;
  }
  console.log(`tools before: ${before.length} → after: ${Object.keys(after).length} (dropped ${dropped})`);
  console.log("dropped names:", before.filter(k => prefixes.some(p => k.startsWith(p))).sort());

  const newToolsValue = { mapValue: { entries: after, kind: "mapValue" }, kind: "mapValue" };
  const actor = client.objectActor.getOrCreate([agentId]);
  await actor.setField("tools", JSON.stringify(newToolsValue));
  console.log("setField tools done");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
