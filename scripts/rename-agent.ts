/**
 * One-shot: rename an agent in place. Patches `name` and rewrites occurrences
 * inside the `system` prompt so the model sees the new identity going forward.
 * Historical blocks are immutable — old assistant turns keep saying the old name,
 * which is the truthful record.
 *
 *   npx tsx scripts/rename-agent.ts <agentId> <oldName> <newName>
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import { stringVal } from "../src/proto.js";

async function main() {
	const [agentId, oldName, newName] = process.argv.slice(2);
	if (!agentId || !oldName || !newName) {
		console.error("Usage: rename-agent.ts <agentId> <oldName> <newName>");
		process.exit(1);
	}

	const client = createClient<typeof app>(resolveEndpoint());
	const store = client.storeActor.getOrCreate(["root"]);
	const obj = await store.get(agentId) as any;
	if (!obj) { console.error(`agent not found: ${agentId}`); process.exit(2); }
	if (obj.typeKey !== "agent") { console.error(`not an agent: ${obj.typeKey}`); process.exit(2); }

	const currentName = obj.fields?.name?.stringValue;
	const currentSystem = obj.fields?.system?.stringValue ?? "";
	console.log(`current name:   ${currentName}`);
	console.log(`system length:  ${currentSystem.length} chars`);
	console.log(`oldName hits:   ${(currentSystem.match(new RegExp(oldName, "g")) || []).length}`);

	const newSystem = currentSystem.split(oldName).join(newName);
	const replaced = (currentSystem.match(new RegExp(oldName, "g")) || []).length;
	console.log(`replacements:   ${replaced}`);

	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.setField("name", JSON.stringify(stringVal(newName)));
	if (replaced > 0) {
		await actor.setField("system", JSON.stringify(stringVal(newSystem)));
	}

	const after = await store.get(agentId) as any;
	console.log(`new name:       ${after.fields?.name?.stringValue}`);
	console.log(`new system len: ${(after.fields?.system?.stringValue ?? "").length}`);
	console.log(`changeCount:    ${after.changeCount}`);
	process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
