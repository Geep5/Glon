// Timelord — simplified Proof of Time (VDF) for glon testnet.
//
// This is a FUNCTIONAL BUT NOT CRYPTOGRAPHICALLY SECURE VDF implementation.
// Real VDFs use class groups of unknown order (chiavdf). This simplified
// version uses sequential SHA-256 hashing, which is:
//   - Sequential (each hash depends on the previous)
//   - Verifiable (re-run and compare)
//   - NOT secure against ASICs or specialized hardware
//
// For testnet use only. Replace with chiavdf for mainnet.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { sha256, hexEncode, hexDecode } from "../../crypto.js";

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

/** Default VDF iterations. Tuned for ~1-3 seconds on modern CPUs. */
export const DEFAULT_VDF_ITERATIONS = 5_000_000;

/** Minimum iterations to prevent trivial VDFs. */
export const MIN_ITERATIONS = 100_000;

// ── VDF computation ──────────────────────────────────────────────

export interface VDFOutput {
	challengeHex: string;
	iterations: number;
	resultHex: string;
	durationMs: number;
	ips: number; // iterations per second
}

/** Compute VDF: result = sha256^iterations(challenge). */
export function computeVDF(challenge: Uint8Array, iterations: number): VDFOutput {
	if (iterations < MIN_ITERATIONS) {
		throw new Error(`VDF iterations must be >= ${MIN_ITERATIONS}`);
	}
	const start = Date.now();
	let current = challenge;
	for (let i = 0; i < iterations; i++) {
		current = sha256(current);
	}
	const durationMs = Date.now() - start;
	return {
		challengeHex: hexEncode(challenge),
		iterations,
		resultHex: hexEncode(current),
		durationMs,
		ips: Math.round((iterations / (durationMs / 1000))),
	};
}

/** Verify a VDF output by recomputing. */
export function verifyVDF(output: VDFOutput): boolean {
	try {
		const challenge = hexDecode(output.challengeHex);
		const recomputed = computeVDF(challenge, output.iterations);
		return recomputed.resultHex === output.resultHex;
	} catch {
		return false;
	}
}

/** Derive a challenge from an anchor's merkle_root for deterministic ordering. */
export function deriveChallenge(merkleRootHex: string): Uint8Array {
	// Mix the merkle root with a fixed salt so the challenge is deterministic
	const root = hexDecode(merkleRootHex);
	const salt = new TextEncoder().encode("glon-vdf-challenge-v1");
	const combined = new Uint8Array(root.length + salt.length);
	combined.set(root);
	combined.set(salt, root.length);
	return sha256(combined);
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "compute": {
			const challengeHex = args[0];
			const iterationsArg = args[1];
			if (!challengeHex) {
				print(red("Usage: timelord compute <challenge_hex> [iterations]"));
				break;
			}
			const challenge = hexDecode(challengeHex);
			if (challenge.length !== 32) { print(red("challenge must be 64 hex chars")); break; }
			const iterations = iterationsArg ? Number(iterationsArg) : DEFAULT_VDF_ITERATIONS;
			if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS) {
				print(red(`iterations must be >= ${MIN_ITERATIONS}`));
				break;
			}
			print(dim(`Computing VDF: ${iterations.toLocaleString()} iterations...`));
			const output = computeVDF(challenge, iterations);
			print(green(`Done in ${output.durationMs}ms`));
			print(dim("  result: ") + output.resultHex.slice(0, 16) + "…");
			print(dim("  speed:  ") + `${output.ips.toLocaleString()} iter/s`);
			print(dim("  json:   ") + JSON.stringify(output));
			break;
		}

		case "verify": {
			const json = args[0];
			if (!json) { print(red("Usage: timelord verify <output_json>")); break; }
			let output: VDFOutput;
			try { output = JSON.parse(json); } catch { print(red("Invalid JSON")); break; }
			const start = Date.now();
			const valid = verifyVDF(output);
			const elapsed = Date.now() - start;
			print(valid ? green(`Verified in ${elapsed}ms`) : red("Verification FAILED"));
			break;
		}

		case "benchmark": {
			const iterationsArg = args[0];
			const iterations = iterationsArg ? Number(iterationsArg) : 1_000_000;
			print(dim(`Benchmarking VDF with ${iterations.toLocaleString()} iterations...`));
			const challenge = new Uint8Array(32);
			crypto.getRandomValues(challenge);
			const output = computeVDF(challenge, iterations);
			print(green(`Completed in ${output.durationMs}ms`));
			print(dim("  speed: ") + `${output.ips.toLocaleString()} iter/s`);
			const timeFor5M = (5_000_000 / output.ips * 1000).toFixed(0);
			print(dim(`  estimated time for 5M iter: ${timeFor5M}ms`));
			break;
		}

		case "challenge": {
			const merkleRootHex = args[0];
			if (!merkleRootHex) { print(red("Usage: timelord challenge <merkle_root_hex>")); break; }
			const challenge = deriveChallenge(merkleRootHex);
			print("Challenge: " + hexEncode(challenge));
			break;
		}

		default: {
			print([
				bold("  Timelord") + dim(" — simplified Proof of Time (testnet mode)"),
				`    ${cyan("timelord compute")} ${dim("<challenge_hex> [iterations]")}  run VDF computation`,
				`    ${cyan("timelord verify")} ${dim("<output_json>")}            verify a VDF output`,
				`    ${cyan("timelord benchmark")} ${dim("[iterations]")}         measure VDF speed`,
				`    ${cyan("timelord challenge")} ${dim("<merkle_root>")}        derive challenge from anchor`,
				dim("  This is a TESTNET implementation. Replace with chiavdf for mainnet."),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		compute: async (_ctx: ProgramContext, challengeHex: string, iterations: number) => {
			const challenge = hexDecode(challengeHex);
			return computeVDF(challenge, iterations);
		},
		verify: async (_ctx: ProgramContext, outputJson: string) => {
			const output = JSON.parse(outputJson) as VDFOutput;
			return verifyVDF(output);
		},
		deriveChallenge: async (_ctx: ProgramContext, merkleRootHex: string) => {
			return hexEncode(deriveChallenge(merkleRootHex));
		},
	},
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
};

export default program;

export const __test = {
	computeVDF,
	verifyVDF,
	deriveChallenge,
	DEFAULT_VDF_ITERATIONS,
	MIN_ITERATIONS,
};
