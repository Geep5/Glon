/**
 * Find a source-file object in the DAG by path-suffix and dump its content
 * (decoded from base64) plus length and changeCount. Useful for confirming
 * what an agent actually sees when it calls object_read_source.
 *
 *   npx tsx scripts/dump-handler-source.ts <pathSuffix>
 *   npx tsx scripts/dump-handler-source.ts holdfast.ts
 *   npx tsx scripts/dump-handler-source.ts <pathSuffix> --grep STRING [--grep STRING ...]
 *
 * --grep prints "STRING: true|false" for each pattern, so you can quickly
 * confirm whether the deployed source contains a particular symbol.
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const suffix = process.argv[2];
  if (!suffix) {
    console.error("Usage: dump-handler-source.ts <pathSuffix> [--grep STRING ...]");
    process.exit(1);
  }
  const greps: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--grep" && process.argv[i + 1]) {
      greps.push(process.argv[i + 1]);
      i++;
    }
  }
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const all = await store.list("typescript") as { id: string }[];
  for (const r of all) {
    const obj = await store.get(r.id) as any;
    const path = obj.fields?.path?.stringValue ?? "";
    if (!path.endsWith(suffix)) continue;
    const text = Buffer.from(String(obj.content), "base64").toString("utf-8");
    console.error(`object:      ${r.id}`);
    console.error(`path:        ${path}`);
    console.error(`length:      ${text.length} chars`);
    console.error(`changeCount: ${obj.changeCount}`);
    for (const g of greps) console.error(`grep ${JSON.stringify(g)}: ${text.includes(g)}`);
    if (greps.length === 0) process.stdout.write(text);
    process.exit(0);
  }
  console.error(`no typescript object found with path suffix '${suffix}'`);
  process.exit(2);
}
main().catch(e => { console.error(e); process.exit(1); });
