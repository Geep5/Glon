/**
 * Capture a snapshot of an agent + its principal peer's configuration as JSON.
 * Useful for backup before reseeding or for diff-checking after a rename / config
 * change.
 *
 *   npx tsx scripts/capture-setup.ts <agentId> <principalPeerId>
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const agentId = process.argv[2];
  const principalId = process.argv[3];
  if (!agentId || !principalId) {
    console.error("Usage: capture-setup.ts <agentId> <principalPeerId>");
    process.exit(1);
  }
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);

  const agent = await store.get(agentId) as any;
  const principal = await store.get(principalId) as any;
  if (!agent) { console.error(`agent not found: ${agentId}`); process.exit(2); }
  if (!principal) { console.error(`principal peer not found: ${principalId}`); process.exit(3); }

  const cfg = {
    agent: {
      id: agentId,
      name: agent.fields?.name?.stringValue,
      model: agent.fields?.model?.stringValue,
      systemLength: (agent.fields?.system?.stringValue ?? "").length,
      systemFirst200: (agent.fields?.system?.stringValue ?? "").slice(0, 200),
      max_tool_iterations: agent.fields?.max_tool_iterations?.stringValue,
      compaction_keep_recent_tokens: agent.fields?.compaction_keep_recent_tokens?.stringValue,
      compaction_reserve_tokens: agent.fields?.compaction_reserve_tokens?.stringValue,
      blockCount: (agent.blocks ?? []).length,
    },
    principal: {
      id: principalId,
      display_name: principal.fields?.display_name?.stringValue,
      kind: principal.fields?.kind?.stringValue,
      trust_level: principal.fields?.trust_level?.stringValue,
      discord_id: principal.fields?.discord_id?.stringValue,
      email: principal.fields?.email?.stringValue,
    },
  };
  console.log(JSON.stringify(cfg, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
