/**
 * Bootstrap — seed Glon OS with its own source files and programs.
 *
 * Each source file becomes a Glon object created through the store actor.
 * Program handler files (src/programs/handlers/*.js) are created as
 * type=program objects with the handler source as content.
 *
 * Usage: npm run bootstrap / npx tsx src/bootstrap.ts
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { initDisk } from "./disk.js";
import { stringVal, intVal, mapVal } from "./proto.js";
const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

const SOURCES = [
	"proto/glon.proto",
	"src/proto.ts",
	"src/crypto.ts",
	"src/dag/change.ts",
	"src/dag/dag.ts",
	"src/disk.ts",
	"src/index.ts",
	"src/bootstrap.ts",
	"src/client.ts",
	"src/programs/runtime.ts",
	"src/programs/handlers/ttt.js",
	"src/programs/handlers/chat.js",
	"package.json",
	"tsconfig.json",
];

// Program definitions: handler file → object fields
const PROGRAMS: { file: string; prefix: string; name: string; commands: Record<string, string> }[] = [
	{
		file: "src/programs/handlers/ttt.js",
		prefix: "/ttt",
		name: "Tic-Tac-Toe",
		commands: {
			new: "Start a new game",
			board: "Show the board",
			move: "Make a move",
			history: "Move-by-move replay",
		},
	},
	{
		file: "src/programs/handlers/chat.js",
		prefix: "/chat",
		name: "Chat",
		commands: {
			new: "Create a chat room",
			send: "Send a message",
			read: "Read messages",
			reply: "Reply to a message",
			react: "React to a message",
		},
	},
];

const KIND_MAP: Record<string, string> = {
	".proto": "proto",
	".ts": "typescript",
	".js": "javascript",
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

	// ── Programs ────────────────────────────────────────────────
	console.log("\nSeeding programs...\n");

	for (const prog of PROGRAMS) {
		const absPath = resolve(projectRoot, prog.file);
		let raw: Buffer;
		try {
			raw = readFileSync(absPath);
		} catch {
			console.log(`  SKIP  ${prog.file} (not found)`);
			skipped++;
			continue;
		}

		const contentBase64 = raw.toString("base64");

		// Build commands as a mapVal of string values
		const commandEntries: Record<string, ReturnType<typeof stringVal>> = {};
		for (const [k, v] of Object.entries(prog.commands)) {
			commandEntries[k] = stringVal(v);
		}

		const fieldsJson = JSON.stringify({
			name: stringVal(prog.name),
			prefix: stringVal(prog.prefix),
			commands: mapVal(commandEntries),
		});

		try {
			const id = await store.create("program", fieldsJson, contentBase64);
			console.log(`  OK    ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${id.slice(0, 12)}...`);
			created++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR   ${prog.name} — ${msg}`);
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
