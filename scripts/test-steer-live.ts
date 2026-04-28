/**
 * End-to-end steering verification.
 *
 * Fires two concurrent /holdfast.ingest calls against the live actor host
 * and prints the metrics + final text for each, plus the resulting block
 * sequence on the agent. With steering working correctly:
 *   - Both calls hit the SAME runLoop (one runner, one steerer).
 *   - There are exactly 2 model calls, in order, with monotonically
 *     growing inputTokens (because the second sees the first's response).
 *   - The DAG records [user A, user B, asst A, asst B] in commit order.
 *   - Per-message attribution: A's finalText addresses A, B's addresses B.
 */
import "../src/env.js";
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import {
	loadPrograms,
	startProgramActor,
	dispatchActorAction,
	getProgramActorByPrefix,
	type ProgramContext,
	type ProgramEntry,
} from "../src/programs/runtime.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import { listChangeFiles, readChangeByHex } from "../src/disk.js";
import { hexEncode } from "../src/crypto.js";
import { randomUUID } from "node:crypto";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

function buildContext(overrides: Partial<ProgramContext> = {}): ProgramContext {
	return {
		client, store,
		resolveId: async (raw: string) => raw,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles, readChangeByHex, hexEncode,
		print: () => {},
		randomUUID,
		state: {}, emit: () => {}, programId: "",
		objectActor: (id: string) => client.objectActor.getOrCreate([id]),
		dispatchProgram: async (prefix, action, args) => {
			const inst = getProgramActorByPrefix(prefix);
			if (!inst) throw new Error(`Program not running: ${prefix}`);
			return await dispatchActorAction(inst.programId, action, args, (state) => buildContext({ state, programId: inst.programId }));
		},
		...overrides,
	};
}

async function main() {
	const programs: ProgramEntry[] = await loadPrograms(store, client);
	for (const prog of programs) {
		try {
			await startProgramActor(prog, (state) => buildContext({ state, programId: prog.id }));
		} catch { /* best-effort */ }
	}

	const holdfast = getProgramActorByPrefix("/holdfast");
	if (!holdfast) throw new Error("/holdfast not loaded");

	const peers = await store.list("peer") as { id: string }[];
	const peerId = peers[0]?.id;
	if (!peerId) throw new Error("no peer");

	const callIngest = (text: string) =>
		dispatchActorAction(
			holdfast.programId,
			"ingest",
			["test", peerId, text],
			(state) => buildContext({ state, programId: holdfast.programId }),
		);

	const t0 = Date.now();
	const stamp = (label: string) => console.log(`[${Date.now() - t0}ms] dispatch ${label}`);
	const done = (label: string, r: any) => console.log(`[${Date.now() - t0}ms] resolved ${label}: iters=${r.iterations} in=${r.inputTokens} out=${r.outputTokens} text=${JSON.stringify(r.finalText)}`);
	stamp("alpha");
	const alphaP = callIngest("message ALPHA - just acknowledge alpha and stop").then((r) => { done("alpha", r); return r; });
	stamp("bravo");
	const bravoP = callIngest("message BRAVO - just acknowledge bravo and stop").then((r) => { done("bravo", r); return r; });
	const [a, b] = await Promise.all([alphaP, bravoP]);
	const elapsed = Date.now() - t0;

	console.log(JSON.stringify({
		elapsedMs: elapsed,
		alpha: { iterations: (a as any).iterations, inputTokens: (a as any).inputTokens, outputTokens: (a as any).outputTokens, finalText: (a as any).finalText },
		bravo: { iterations: (b as any).iterations, inputTokens: (b as any).inputTokens, outputTokens: (b as any).outputTokens, finalText: (b as any).finalText },
	}, null, 2));
	process.exit(0);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
