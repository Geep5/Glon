import { createClient } from "rivetkit/client";

async function main() {
  try {
    const client = createClient<any>("http://localhost:6420");
    const objActor = client.objectActor.getOrCreate(["90c86a5aa43e4a5db979e659"]);
    console.log("objActor created");

    // Try pushing a dummy change (will fail validation but should show us where the error is)
    await objActor.pushChanges("dGVzdA==");
    console.log("push succeeded");
  } catch (e: any) {
    console.error("ERROR:", e.message);
    console.error("STACK:", e.stack);
  }
}

main();
