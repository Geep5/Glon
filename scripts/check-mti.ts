/**
 * Inspect or set max_tool_iterations on an agent.
 *
 *   npx tsx scripts/check-mti.ts <agentId>          # read
 *   npx tsx scripts/check-mti.ts <agentId> 1000     # write + read-back
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import { stringVal } from "../src/proto.js";

async function main() {
  const agentId = process.argv[2];
  const setTo = process.argv[3];
  if (!agentId) {
    console.error("Usage: check-mti.ts <agentId> [newValue]");
    process.exit(1);
  }
  const client = createClient<typeof app>(resolveEndpoint());
  if (setTo) {
    const actor = client.objectActor.getOrCreate([agentId]);
    await actor.setField("max_tool_iterations", JSON.stringify(stringVal(setTo)));
    console.log(`setField max_tool_iterations="${setTo}" sent`);
  }
  const store = client.storeActor.getOrCreate(["root"]);
  const after = await store.get(agentId) as any;
  if (!after) { console.error(`agent not found: ${agentId}`); process.exit(2); }
  console.log("max_tool_iterations:", JSON.stringify(after.fields?.max_tool_iterations));
  console.log("agentName:", after.fields?.name?.stringValue);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
