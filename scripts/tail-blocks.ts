import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
async function main() {
  const id = process.argv[2];
  const tail = parseInt(process.argv[3] ?? "20", 10);
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const o = await store.get(id) as any;
  const blocks = o?.blocks ?? [];
  const N = blocks.length;
  console.log(`total blocks: ${N}`);
  for (let i = Math.max(0, N - tail); i < N; i++) {
    const b = blocks[i];
    const text = b.content?.text?.text;
    const cType = b.content?.custom?.contentType;
    const meta = b.content?.custom?.meta ?? {};
    const tag = cType ?? (b.content?.text?.style === 1 ? "user" : b.content?.text?.style === 2 ? "asst" : "text");
    const head = (text ?? meta.tool_name ?? meta.name ?? "").toString().slice(0, 240);
    const tu = meta.tool_use_id ? ` tu=${meta.tool_use_id.slice(0,16)}` : "";
    const isErr = meta.is_error === "true" ? " [ERROR]" : "";
    console.log(`[${i}] ${tag.padEnd(12)}${tu}${isErr}`);
    if (head) console.log(`    ${head.replace(/\n/g, "\n    ")}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
