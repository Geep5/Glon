/**
 * Print a quick summary of an agent: name, model, tool count, system prompt
 * length + head, compaction tuning, block count.
 *
 *   npx tsx scripts/agent-info.ts <agentId>
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error("Usage: agent-info.ts <agentId>");
    process.exit(1);
  }
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const agent = await store.get(agentId) as any;
  if (!agent) { console.error(`agent not found: ${agentId}`); process.exit(2); }
  if (agent.typeKey !== "agent") {
    console.error(`object ${agentId} is not an agent (typeKey=${agent.typeKey})`);
    process.exit(3);
  }

  const sys = agent.fields?.system?.stringValue ?? "";
  const tools = agent.fields?.tools?.mapValue?.entries ?? {};
  const toolNames = Object.keys(tools).sort();

  console.log(`agent:        ${agentId}`);
  console.log(`name:         ${agent.fields?.name?.stringValue ?? "(unset)"}`);
  console.log(`model:        ${agent.fields?.model?.stringValue ?? "(default)"}`);
  console.log(`tools wired:  ${toolNames.length}`);
  if (toolNames.length > 0) {
    // Group by prefix before the first underscore (peer_, memory_, object_, etc.)
    const groups = new Map<string, number>();
    for (const n of toolNames) {
      const prefix = n.includes("_") ? n.split("_", 1)[0] : n;
      groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
    }
    const groupSummary = [...groups.entries()].map(([k, v]) => `${k}_*=${v}`).join("  ");
    console.log(`              ${groupSummary}`);
  }
  console.log(`system:       ${sys.length} chars`);
  if (sys) console.log(`              ${sys.split("\n")[0].slice(0, 120)}${sys.length > 120 ? "..." : ""}`);
  console.log(`max_tool_iter:${agent.fields?.max_tool_iterations?.stringValue ?? "(default)"}`);
  console.log(`compact keep: ${agent.fields?.compaction_keep_recent_tokens?.stringValue ?? "(default)"}`);
  console.log(`compact rsv:  ${agent.fields?.compaction_reserve_tokens?.stringValue ?? "(default)"}`);
  console.log(`blocks:       ${(agent.blocks ?? []).length}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
