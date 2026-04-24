/**
 * Read an agent's blocks to debug tool-use loops. Usage:
 *   npx tsx scripts/read-agent-blocks.ts <agent-id>
 */
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";

async function main() {
	const agentId = process.argv[2];
	if (!agentId) {
		console.error("Usage: read-agent-blocks.ts <agent-id>");
		process.exit(1);
	}
	const client = createClient<typeof app>(process.env.GLON_ENDPOINT ?? "http://localhost:6420");
	const actor = client.objectActor.getOrCreate([agentId]);
	const state = await actor.read() as any;
	const blocks = state?.blocks ?? [];
	console.log(`blocks: ${blocks.length}`);
	const recent = blocks.slice(-20);
	for (const b of recent) {
		const c = b.content ?? {};
		if (c.text) {
			const t = (c.text.text ?? "").slice(0, 220);
			const role = c.text.style === 1 ? "assistant" : "user";
			console.log(`  [${role}] ${t}`);
		} else if (c.custom) {
			const ct = c.custom.contentType ?? c.custom.content_type ?? "?";
			const meta = c.custom.meta ?? {};
			if (ct === "tool_use") {
				console.log(`  [tool_use] ${meta.tool_name}(${(meta.input ?? "").slice(0, 180)})`);
			} else if (ct === "tool_result") {
				const err = meta.is_error === "true";
				const content = (meta.content ?? "").slice(0, 200);
				console.log(`  [tool_result${err ? " ERROR" : ""}] ${content}`);
			} else {
				console.log(`  [${ct}] ${JSON.stringify(meta).slice(0, 180)}`);
			}
		}
	}
	process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
