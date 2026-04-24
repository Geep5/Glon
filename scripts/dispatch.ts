/**
 * Fire one action against a running Glon daemon.
 *
 *   npx tsx scripts/dispatch.ts <prefix> <action> '<argsJson>'
 *
 * Example:
 *   npx tsx scripts/dispatch.ts /gracie bootstrap '{"grantName":"Grant"}'
 *   npx tsx scripts/dispatch.ts /discord send '[{"peer_id":"abc","text":"hi"}]'
 *
 * argsJson is either a JSON array (positional args) or any other JSON
 * value (treated as a single arg).
 */

import "../src/env.js"; // side-effect: load .env into process.env
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";

const ENDPOINT = resolveEndpoint();

async function main() {
	const [prefix, action, argsRaw] = process.argv.slice(2);
	if (!prefix || !action) {
		console.error("Usage: dispatch.ts <prefix> <action> '<argsJson>'");
		process.exit(1);
	}

	let args: unknown[] = [];
	if (argsRaw) {
		const parsed = JSON.parse(argsRaw);
		args = Array.isArray(parsed) ? parsed : [parsed];
	}

	const client = createClient<typeof app>(ENDPOINT);
	// The programActor's programId is just the raw prefix for dispatch purposes
	// — we use the store to find it.
	const store = client.storeActor.getOrCreate(["root"]);
	const refs = await store.list("program");
	const refsArr = refs as { id: string }[];

	let programObjId: string | null = null;
	for (const ref of refsArr) {
		const state = await store.get(ref.id) as { fields?: Record<string, any> } | null;
		const p = state?.fields?.prefix?.stringValue ?? state?.fields?.prefix;
		if (p === prefix) { programObjId = ref.id; break; }
	}
	if (!programObjId) {
		console.error(`no program with prefix ${prefix}`);
		process.exit(2);
	}

	const progActor = client.programActor.getOrCreate([programObjId]);
	const result = await progActor.dispatch(action, JSON.stringify(args));
	const parsed = result ? JSON.parse(result as string) : null;
	console.log(JSON.stringify(parsed, null, 2));
	process.exit(0);
}

main().catch((err) => {
	console.error("dispatch error:", err?.message ?? err);
	process.exit(1);
});
