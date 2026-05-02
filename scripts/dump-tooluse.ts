import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const agentId = process.argv[2];
  const fromIdx = parseInt(process.argv[3] ?? "0", 10);
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const o = await store.get(agentId) as any;
  const blocks = o?.blocks ?? [];
  for (let i = fromIdx; i < blocks.length; i++) {
    const b = blocks[i];
    const cType = b.content?.custom?.contentType;
    if (cType !== "tool_use" && cType !== "tool_result") continue;
    const meta = b.content?.custom?.meta ?? {};
    if (cType === "tool_use") {
      console.log(`\n[${i}] tool_use ${meta.tool_name} tu=${meta.tool_use_id?.slice(0,16)}`);
      const input = meta.input;
      if (input) console.log("  input:", String(input).slice(0, 500));
    } else {
      console.log(`[${i}] tool_result tu=${meta.tool_use_id?.slice(0,16)} is_error=${meta.is_error}`);
      const content = meta.content;
      if (content) console.log("  result:", String(content).slice(0, 600));
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
