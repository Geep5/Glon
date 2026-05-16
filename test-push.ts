import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);

async function main() {
  const store = client.storeActor.getOrCreate(["root"]);
  
  // Try to create a simple test object
  const testId = "test-" + Date.now();
  try {
    const actor = client.objectActor.getOrCreate([testId], { createWithInput: { id: testId, typeKey: "json" } });
    await actor.pushChanges("");
    console.log("Test push succeeded");
  } catch (e: any) {
    console.log("Test push failed:", e?.message || e);
  }
}

main().catch(console.error);
