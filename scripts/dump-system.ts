/**
 * Dump an agent's current system prompt to stdout (or a file with --out).
 *
 *   npx tsx scripts/dump-system.ts <agentId>
 *   npx tsx scripts/dump-system.ts <agentId> --out path/to/file.txt
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import { writeFileSync } from "node:fs";

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error("Usage: dump-system.ts <agentId> [--out path]");
    process.exit(1);
  }
  let outPath: string | null = null;
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--out" && process.argv[i + 1]) {
      outPath = process.argv[i + 1];
      i++;
    }
  }

  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const agent = await store.get(agentId) as any;
  if (!agent) { console.error(`agent not found: ${agentId}`); process.exit(2); }
  const sys = agent.fields?.system?.stringValue ?? "";

  if (outPath) {
    writeFileSync(outPath, sys);
    console.error(`wrote ${sys.length} chars to ${outPath}`);
  } else {
    process.stdout.write(sys);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
