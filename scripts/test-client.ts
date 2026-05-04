import { createClient } from "rivetkit/client";

async function main() {
  try {
    const client = createClient<any>("http://localhost:6420");
    console.log("client created");
    const objActor = client.objectActor.getOrCreate(["90c86a5aa43e4a5db979e659"]);
    console.log("objActor created");
    const obj = await objActor.read();
    console.log("read succeeded", obj ? "got object" : "null");
  } catch (e: any) {
    console.error("ERROR:", e.message);
    console.error("STACK:", e.stack);
  }
}

main();
