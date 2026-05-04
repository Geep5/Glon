// Plot — simplified Proof of Space for glon testnet.
//
// This is a FUNCTIONAL BUT NOT CRYPTOGRAPHICALLY SECURE proof-of-space
// implementation for testing the PoST integration. It can be swapped for
// real chiapos (https://github.com/Chia-Network/chiapos) once that library
// is available on the target system.
//
// Simplified model:
//   - A plot is a file of N random 32-byte hashes
//   - Challenge = 32-byte hash
//   - Proof = the hash in the plot with smallest XOR distance to challenge
//   - Quality = distance (lower = better)
//   - Winning = distance < threshold (difficulty parameter)
//
// This is vulnerable to grinding attacks (an attacker can generate plots
// until they find one that wins often). For a real deployment, replace
// with chiapos's secure proof-of-space construction.

import type { ProgramDef, ProgramContext } from "../runtime.js";
import { sha256, hexEncode, hexDecode } from "../../crypto.js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

/** Default plot size: number of 32-byte entries. ~32MB at 1M entries. */
export const DEFAULT_PLOT_ENTRIES = 1_000_000;

/** Hash size in bytes. */
const HASH_SIZE = 32;

/** Directory for plot files. */
function plotDir(): string {
	return process.env.GLON_PLOT_DIR ?? join(homedir(), ".glon", "plots");
}

// ── Plot format ──────────────────────────────────────────────────

interface PlotHeader {
	version: number;
	entries: number;
	pubkeyHex: string;
	createdAt: number;
}

const CURRENT_VERSION = 1;

/** Plot file layout: header JSON line + raw hashes */
function plotPath(name: string): string {
	return join(plotDir(), `${name}.plot`);
}

function readPlotHeader(path: string): PlotHeader | null {
	try {
		const fd = readFileSync(path);
		// First line is JSON header, rest is raw hashes
		const nl = fd.indexOf(0x0a); // '\n'
		if (nl < 0) return null;
		const header = JSON.parse(fd.slice(0, nl).toString("utf-8")) as PlotHeader;
		return header;
	} catch {
		return null;
	}
}

// ── Plot creation ────────────────────────────────────────────────

async function createPlot(
	name: string,
	entries: number,
	pubkeyHex: string,
	onProgress?: (pct: number) => void,
): Promise<{ path: string; entries: number; sizeBytes: number }> {
	const dir = plotDir();
	mkdirSync(dir, { recursive: true });
	const path = plotPath(name);

	const header: PlotHeader = {
		version: CURRENT_VERSION,
		entries,
		pubkeyHex,
		createdAt: Date.now(),
	};

	// Write header + hashes in batches to avoid memory pressure.
	const batchSize = 10_000;
	const headerBuf = Buffer.from(JSON.stringify(header) + "\n", "utf-8");
	const parts: Buffer[] = [headerBuf];
	let written = 0;

	for (let i = 0; i < entries; i += batchSize) {
		const count = Math.min(batchSize, entries - i);
		const batch = randomBytes(count * HASH_SIZE);
		parts.push(batch);
		written += count;
		if (onProgress && i % (entries / 10) < batchSize) {
			onProgress(Math.floor((written / entries) * 100));
		}
		// Yield to event loop
		await new Promise((r) => setTimeout(r, 0));
	}

	const total = Buffer.concat(parts);
	writeFileSync(path, total);
	const sizeBytes = total.length;

	return { path, entries, sizeBytes };
}

// ── Proof generation ─────────────────────────────────────────────

export interface PlotProof {
	plotName: string;
	challengeHex: string;
	bestHashHex: string;
	distanceHex: string;
	quality: number; // 0..255 (lower = better), derived from leading zero bits of distance
	entryIndex: number;
}

/** Find the best proof in a plot for a given challenge. */
function findProof(plotPath: string, challenge: Uint8Array, plotName: string): PlotProof | null {
	const header = readPlotHeader(plotPath);
	if (!header) return null;

	const fd = readFileSync(plotPath);
	const nl = fd.indexOf(0x0a);
	if (nl < 0) return null;
	const dataStart = nl + 1;
	const data = fd.slice(dataStart);
	const entries = data.length / HASH_SIZE;

	let bestIndex = -1;
	let bestDistance: Uint8Array | null = null;

	for (let i = 0; i < entries; i++) {
		const offset = i * HASH_SIZE;
		const hash = data.slice(offset, offset + HASH_SIZE);
		const distance = xor256(hash, challenge);

		if (bestDistance === null || compare256(distance, bestDistance) < 0) {
			bestDistance = distance;
			bestIndex = i;
		}
	}

	if (bestIndex < 0 || !bestDistance) return null;

	// Quality = count of leading zero bits in distance (higher = better proof)
	let quality = 0;
	for (let i = 0; i < HASH_SIZE; i++) {
		const byte = bestDistance[i];
		if (byte === 0) {
			quality += 8;
		} else {
			quality += Math.clz32(byte) - 24; // clz32 works on 32-bit, shift
			break;
		}
	}

	return {
		plotName,
		challengeHex: hexEncode(challenge),
		bestHashHex: hexEncode(data.slice(bestIndex * HASH_SIZE, (bestIndex + 1) * HASH_SIZE)),
		distanceHex: hexEncode(bestDistance),
		quality,
		entryIndex: bestIndex,
	};
}

/** XOR two 32-byte arrays. */
function xor256(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(HASH_SIZE);
	for (let i = 0; i < HASH_SIZE; i++) out[i] = a[i] ^ b[i];
	return out;
}

/** Compare two 32-byte arrays lexicographically. */
function compare256(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < HASH_SIZE; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

// ── Proof verification ───────────────────────────────────────────

/** Verify that a proof was honestly derived from a plot. */
export function verifyProof(
	proof: PlotProof,
	challenge: Uint8Array,
	plotPath: string,
): boolean {
	const header = readPlotHeader(plotPath);
	if (!header) return false;

	const fd = readFileSync(plotPath);
	const nl = fd.indexOf(0x0a);
	if (nl < 0) return false;
	const dataStart = nl + 1;
	const data = fd.slice(dataStart);

	if (proof.entryIndex < 0 || proof.entryIndex >= header.entries) return false;

	const offset = proof.entryIndex * HASH_SIZE;
	const storedHash = data.slice(offset, offset + HASH_SIZE);
	if (hexEncode(storedHash) !== proof.bestHashHex) return false;

	const computedDistance = xor256(storedHash, challenge);
	if (hexEncode(computedDistance) !== proof.distanceHex) return false;

	// Recompute quality
	let quality = 0;
	for (let i = 0; i < HASH_SIZE; i++) {
		const byte = computedDistance[i];
		if (byte === 0) {
			quality += 8;
		} else {
			quality += Math.clz32(byte) - 24;
			break;
		}
	}

	return quality === proof.quality;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "create": {
			const name = args[0];
			if (!name) { print(red("Usage: plot create <name> [entries] [--pubkey=hex]")); break; }
			const entriesArg = args[1];
			const entries = entriesArg ? Number(entriesArg) : DEFAULT_PLOT_ENTRIES;
			if (!Number.isFinite(entries) || entries < 100) {
				print(red("entries must be >= 100"));
				break;
			}
			const pkArg = args.find((a) => a.startsWith("--pubkey="));
			const pubkeyHex = pkArg ? pkArg.split("=")[1] : "testnet";

			print(dim(`Creating plot "${name}" with ${entries.toLocaleString()} entries...`));
			const start = Date.now();
			const { path, sizeBytes } = await createPlot(name, entries, pubkeyHex, (pct) => {
				print(dim(`  ${pct}%`));
			});
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			print(green(`Plot created in ${elapsed}s`));
			print(dim("  path: ") + path);
			print(dim("  size: ") + `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);
			print(dim("  entries: ") + entries.toLocaleString());
			break;
		}

		case "list": {
			const dir = plotDir();
			const { readdirSync } = await import("node:fs");
			let files: string[] = [];
			try { files = readdirSync(dir).filter((f) => f.endsWith(".plot")); } catch { /* empty */ }
			if (files.length === 0) { print(dim("  (no plots)")); break; }
			for (const f of files.sort()) {
				const path = join(dir, f);
				const header = readPlotHeader(path);
				const stat = statSync(path);
				const name = f.replace(/\.plot$/, "");
				if (header) {
					print(`  ${cyan(name)}  ${header.entries.toLocaleString()} entries  ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
				} else {
					print(`  ${cyan(name)}  ${dim("(invalid header)")}`);
				}
			}
			break;
		}

		case "prove": {
			const name = args[0];
			const challengeHex = args[1];
			if (!name || !challengeHex) {
				print(red("Usage: plot prove <name> <challenge_hex>"));
				break;
			}
			const path = plotPath(name);
			if (!existsSync(path)) { print(red(`Plot "${name}" not found`)); break; }
			const challenge = hexDecode(challengeHex);
			if (challenge.length !== HASH_SIZE) { print(red("challenge must be 64 hex chars (32 bytes)")); break; }

			const start = Date.now();
			const proof = findProof(path, challenge, name);
			const elapsed = Date.now() - start;

			if (!proof) { print(red("No proof found (plot error)")); break; }

			print(green(`Proof found in ${elapsed}ms`));
			print(dim("  best hash:  ") + proof.bestHashHex.slice(0, 16) + "…");
			print(dim("  distance:   ") + proof.distanceHex.slice(0, 16) + "…");
			print(dim("  quality:    ") + proof.quality + " bits");
			print(dim("  entry:      ") + proof.entryIndex.toLocaleString());
			break;
		}

		case "verify": {
			const name = args[0];
			const challengeHex = args[1];
			const proofJson = args[2];
			if (!name || !challengeHex || !proofJson) {
				print(red("Usage: plot verify <name> <challenge_hex> <proof_json>"));
				break;
			}
			const path = plotPath(name);
			if (!existsSync(path)) { print(red(`Plot "${name}" not found`)); break; }
			const challenge = hexDecode(challengeHex);
			const proof = JSON.parse(proofJson) as PlotProof;
			const valid = verifyProof(proof, challenge, path);
			print(valid ? green("Proof valid") : red("Proof INVALID"));
			break;
		}

		default: {
			print([
				bold("  Plot") + dim(" — simplified Proof of Space (testnet mode)"),
				`    ${cyan("plot create")} ${dim("<name> [entries] [--pubkey=hex]")}  create a plot file`,
				`    ${cyan("plot list")}                         list all plot files`,
				`    ${cyan("plot prove")} ${dim("<name> <challenge>")}     find best proof for challenge`,
				`    ${cyan("plot verify")} ${dim("<name> <challenge> <proof_json>")} verify a proof`,
				dim("  This is a TESTNET implementation. Replace with chiapos for mainnet."),
			].join("\n"));
		}
	}
};

// ── Exports ──────────────────────────────────────────────────────

const program: ProgramDef = {
	handler,
};

export default program;

export const __test = {
	createPlot,
	findProof,
	verifyProof,
	xor256,
	compare256,
	DEFAULT_PLOT_ENTRIES,
};
