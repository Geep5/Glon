/**
 * Figgies — peer sync loop.
 *
 * Every device knows a small list of peer URLs (configured via the
 * FIGGIES_PEERS env var, comma-separated). On a timer we ask each peer
 * for ops we haven't seen yet and apply them locally. Conflicts are
 * vanishingly rare in a family setting; idempotency on op.id handles
 * the duplicates that arise from cross-talk.
 *
 * No DHT, no Hyperswarm, no DNS — just configured peers. If you want a
 * device to reach the family when away from home Wi-Fi, point it at the
 * home server's URL.
 */

import { applyOp, opsSince, getState, type Op } from "./state.js";

const POLL_INTERVAL_MS = 5_000;

function parsePeers(): string[] {
	const raw = process.env.FIGGIES_PEERS ?? "";
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => (s.startsWith("http://") || s.startsWith("https://") ? s : `http://${s}`));
}

/** Per-peer cursor — the last op id we successfully pulled. */
const peerCursors = new Map<string, string | null>();

async function pullFromPeer(peerUrl: string): Promise<void> {
	const cursor = peerCursors.get(peerUrl) ?? null;
	const url = new URL("/ops", peerUrl);
	if (cursor) url.searchParams.set("since", cursor);

	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
	} catch (err: any) {
		// peer offline / unreachable — silent retry next tick
		return;
	}
	if (!res.ok) return;

	const body = (await res.json()) as { ops?: Op[] };
	const ops = body?.ops ?? [];
	if (ops.length === 0) return;

	let applied = 0;
	for (const op of ops) {
		const r = applyOp(op);
		if (r.ok) applied++;
	}
	if (applied > 0) {
		console.log(`[sync] pulled ${applied} new op(s) from ${peerUrl}`);
	}

	// Advance cursor to the last op we saw, even if some were rejected —
	// rejected ops won't become acceptable on re-fetch.
	const last = ops[ops.length - 1];
	if (last) peerCursors.set(peerUrl, last.id);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSync(): void {
	const peers = parsePeers();
	if (peers.length === 0) {
		console.log(`[sync] no peers configured (set FIGGIES_PEERS to enable)`);
		return;
	}
	console.log(`[sync] polling ${peers.length} peer(s) every ${POLL_INTERVAL_MS / 1000}s: ${peers.join(", ")}`);
	const tick = async () => {
		await Promise.all(peers.map((p) => pullFromPeer(p).catch(() => { /* swallow */ })));
	};
	void tick();
	timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopSync(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

export function peerStatus(): Array<{ url: string; cursor: string | null }> {
	return parsePeers().map((url) => ({ url, cursor: peerCursors.get(url) ?? null }));
}
