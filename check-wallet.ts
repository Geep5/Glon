import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";

const client = createClient<typeof app>(resolveEndpoint());

async function main() {
  const walletActor = client.walletActor.getOrCreate(["default"]);
  const keys = await walletActor.list();
  console.log("Keys:", keys.length);
  for (const k of keys) {
    console.log(k.name, ":", k.pubkey);
  }
}

main().catch(console.error);
