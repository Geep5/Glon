import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);
  const obj = await store.get("8f9fce76-8ae0-404a-b4a3-aa3c4a148506");
  console.log(JSON.stringify(obj, null, 2));
}

main().catch(console.error);
