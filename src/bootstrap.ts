/**
 * Bootstrap — seed Glon OS with its own source files.
 *
 * Each source file becomes a Glon object created through the store actor.
 * The store handles genesis/field/content changes, disk writes, indexing,
 * and object actor spawning.
 *
 * Usage: npm run bootstrap / npx tsx src/bootstrap.ts
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { initDisk } from "./disk.js";
import { stringVal, intVal } from "./proto.js";

const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

const SOURCES = [
	"proto/glon.proto",
	"src/proto.ts",
	"src/crypto.ts",
	"src/dag/change.ts",
	"src/dag/dag.ts",
	"src/actors/object.ts",
	"src/actors/store.ts",
	"src/disk.ts",
	"src/index.ts",
	"src/bootstrap.ts",
	"src/client.ts",
	"package.json",
	"tsconfig.json",
];

const KIND_MAP: Record<string, string> = {
	".proto": "proto",
	".ts": "typescript",
	".json": "json",
};

function kindOf(file: string): string {
	return KIND_MAP[extname(file)] ?? "unknown";
}

async function main() {
	const projectRoot = resolve(import.meta.dirname ?? ".", "..");

	initDisk();

	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);

	console.log("Bootstrapping Glon OS...\n");

	let created = 0;
	let skipped = 0;

	for (const relPath of SOURCES) {
		const absPath = resolve(projectRoot, relPath);
		const name = basename(relPath);
		const kind = kindOf(relPath);

		let raw: Buffer;
		try {
			raw = readFileSync(absPath);
		} catch {
			console.log(`  SKIP  ${relPath} (not found)`);
			skipped++;
			continue;
		}

		const lineCount = raw.toString("utf-8").split("\n").length;
		const contentBase64 = raw.toString("base64");

		// Fields: name, path, lines, size — serialized as JSON Record<string, Value>
		const fieldsJson = JSON.stringify({
			name: stringVal(name),
			path: stringVal(relPath),
			lines: intVal(lineCount),
			size: intVal(raw.byteLength),
		});

		try {
			const id = await store.create(kind, fieldsJson, contentBase64);
			console.log(`  OK    ${relPath.padEnd(28)} ${kind.padEnd(12)} ${id.slice(0, 12)}...`);
			created++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR   ${relPath} — ${msg}`);
			skipped++;
		}
	}

	console.log(`\nDone. ${created} created, ${skipped} skipped.`);

	try {
		const info = await store.info();
		console.log(`Store: ${info.totalObjects} objects, ${info.totalChanges} changes.`);
		for (const [typeKey, cnt] of Object.entries(info.byType)) {
			console.log(`  ${typeKey}: ${cnt}`);
		}
	} catch {
		// Store info may fail if not fully ready; non-fatal.
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("Bootstrap failed:", err);
	process.exit(1);
});
