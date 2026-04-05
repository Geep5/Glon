/**
 * Bootstrap — seeds the OS with its own source files.
 *
 * Populates both the Rivet actor store AND the local disk.
 * Each source file becomes:
 *   1. A protobuf glon.Object encoded to raw bytes on disk (~/.glon/objects/)
 *   2. An entry in the Rivet store actor's SQLite index
 *
 * The OS is self-describing: the protobuf bytes on your hard drive
 * ARE the operating system.
 *
 * Usage: npm run bootstrap
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { initDisk, writeToDisk, diskStats } from "./disk.js";
import { createObject, deriveId } from "./proto.js";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

// Every file that constitutes Glon OS.
const SOURCES = [
	"proto/glon.proto",
	"src/proto.ts",
	"src/actors/object.ts",
	"src/actors/store.ts",
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
	".md": "markdown",
	".html": "html",
};

function kindFromExt(path: string): string {
	return KIND_MAP[extname(path)] ?? "file";
}

async function bootstrap() {
	const client = createClient<typeof app>("http://localhost:6420");
	const store = client.storeActor.getOrCreate(["root"]);

	console.log("Bootstrapping Glon OS...\n");

	let created = 0;

	// Ensure disk storage exists
	initDisk();

	for (const relPath of SOURCES) {
		const absPath = resolve(ROOT, relPath);
		const name = basename(relPath);
		const kind = kindFromExt(relPath);

		let content: Buffer;
		try {
			content = readFileSync(absPath);
		} catch {
			console.log(`  skip  ${relPath} (not found)`);
			continue;
		}

		const contentBase64 = content.toString("base64");
		const meta: Record<string, string> = {
			path: relPath,
			lines: content.toString("utf-8").split("\n").length.toString(),
			size: content.byteLength.toString(),
		};

		const id = await store.create({ kind, name, content: contentBase64, meta });

		// Write raw protobuf bytes to disk
		const obj = createObject({
			id: deriveId(kind, name),
			kind,
			name,
			content: new Uint8Array(content),
			meta,
		});
		writeToDisk(obj);

		console.log(`  ${kind.padEnd(12)} ${relPath.padEnd(30)} → ${id}`);
		created++;
	}

	console.log(`\n${created} objects created.`);

	const info = await store.info();
	console.log(`\nSystem info:`);
	console.log(`  total objects: ${info.totalObjects}`);
	for (const { kind, cnt } of info.byKind) {
		console.log(`  ${kind}: ${cnt}`);
	}
}

bootstrap().catch((err) => {
	console.error("Bootstrap failed:", err);
	process.exit(1);
});
