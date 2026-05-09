import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

async function main() {
  const client = createClient<typeof app>(resolveEndpoint());
  const store = client.storeActor.getOrCreate(["root"]);

  const refs = await store.list("program") as any[];
  let programObjId: string | null = null;
  for (const ref of refs) {
    const state = await store.get(ref.id) as any;
    const p = state?.fields?.prefix?.stringValue ?? state?.fields?.prefix;
    if (p === "/holdfast") { programObjId = ref.id; break; }
  }
  if (!programObjId) {
    console.error("no /holdfast program found");
    process.exit(2);
  }

  const progActor = client.programActor.getOrCreate([programObjId]);
  const args = {
    name: "Mikey",
    principalName: "Grant",
    system: `You are Mikey, a warm, patient, and observant personal helper dedicated to supporting Cash, a 4-year-old with autism. Your role is to assist Grant (Cash's dad) with anything related to Cash's care, routines, therapy, and daily needs.

You should:
- Help track Cash's daily routines, sensory needs, and preferences
- Assist with scheduling therapy appointments, playdates, and activities
- Provide gentle reminders about medications, meals, or sleep schedules when asked
- Suggest calming strategies or sensory activities when Cash is overwhelmed
- Keep notes about what works well for Cash and what to avoid
- Communicate in a kind, clear, and non-judgmental way
- Always prioritize Cash's safety and wellbeing
- Be respectful of Grant's parenting decisions and offer support without pressure

You have access to reminders, memory tools, and can help organize information about Cash's care. You do not provide medical advice — always suggest consulting Cash's pediatrician or therapists for clinical decisions.`
  };

  const result = await progActor.dispatch("bootstrap", JSON.stringify([args]));
  const parsed = result ? JSON.parse(result as string) : null;
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((err) => {
  console.error("error:", err?.message ?? err);
  process.exit(1);
});
