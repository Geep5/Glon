/**
 * Endpoint resolver — deterministic port handoff between server and clients.
 *
 * The RivetKit server binds a port (6420 by default, or `GLON_PORT`).
 * Every client (bootstrap, REPL, daemon, dispatch) needs that same port.
 * To avoid silent mismatches when 6420 is taken or customized, the server
 * writes the actual endpoint to a lockfile inside `GLON_DATA`; clients
 * read it when `GLON_ENDPOINT` is not set.
 *
 * Resolution order for `resolveEndpoint()`:
 *   1. `GLON_ENDPOINT` env var (explicit override wins)
 *   2. `<GLON_DATA>/.endpoint` lockfile (written by the running server)
 *   3. `http://localhost:<GLON_PORT or 6420>` (last-resort default)
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getGlonRoot } from "./disk.js";

const LOCKFILE = join(getGlonRoot(), ".endpoint");

export function desiredPort(): number {
	const raw = process.env.GLON_PORT;
	if (!raw) return 6420;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
		throw new Error(`GLON_PORT must be a valid TCP port, got: ${raw}`);
	}
	return n;
}

export function defaultEndpoint(): string {
	return `http://localhost:${desiredPort()}`;
}

export function writeEndpointLockfile(port: number): void {
	mkdirSync(getGlonRoot(), { recursive: true });
	writeFileSync(LOCKFILE, `http://localhost:${port}\n`, "utf-8");
}

export function clearEndpointLockfile(): void {
	try {
		if (existsSync(LOCKFILE)) unlinkSync(LOCKFILE);
	} catch {
		/* best-effort cleanup */
	}
}

/** Read lockfile if present and valid (file may be stale across reboots). */
function readEndpointLockfile(): string | null {
	if (!existsSync(LOCKFILE)) return null;
	try {
		const raw = readFileSync(LOCKFILE, "utf-8").trim();
		if (!raw) return null;
		new URL(raw); // validate
		return raw;
	} catch {
		return null;
	}
}

export function resolveEndpoint(): string {
	const override = process.env.GLON_ENDPOINT;
	if (override) return override;
	const fromLockfile = readEndpointLockfile();
	if (fromLockfile) return fromLockfile;
	return defaultEndpoint();
}

/**
 * Fail fast if the desired port is already bound.
 *
 * Rationale: RivetKit silently falls back to the next free port. Clients
 * that expect 6420 then connect to nothing. We'd rather abort with a
 * clear message so the user can set `GLON_PORT` or free the port.
 */
export async function assertPortAvailable(port: number): Promise<void> {
	// HTTP probe — if anything answers on `localhost:port`, the port is taken.
	// `localhost` resolves to both IPv4 and IPv6, so this catches RivetKit's
	// IPv6-wildcard binding that a TCP-socket probe on 127.0.0.1 would miss.
	try {
		await fetch(`http://localhost:${port}/`, {
			signal: AbortSignal.timeout(500),
		});
		// Any successful HTTP round-trip means *something* is listening.
		throw new Error(
			`port ${port} is already in use.\n` +
				`  Another Glon instance may be running, or port ${port} is taken by something else.\n` +
				`  Set GLON_PORT to a free port (e.g. GLON_PORT=6520) and retry.`,
		);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith(`port ${port} is already in use`)) {
			throw err;
		}
		// Anything else (ECONNREFUSED, abort, DNS failure) means nothing is
		// answering on the port — which is what we want.
	}
}
