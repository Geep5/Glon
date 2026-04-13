/**
 * Bootstrap — seed Glon OS with its own source files and programs.
 *
 * Each source file becomes a Glon object created through the store actor.
 * Programs (src/programs/handlers/*.ts) are created as type=program objects
 * with manifest fields mapping module filenames to source strings.
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
	"src/programs/handlers/ttt.ts",
	"src/programs/handlers/chat.ts",
	"src/programs/handlers/agent.ts",
	"src/programs/handlers/gc.ts",
	"src/programs/handlers/accounts.ts",
	"src/programs/handlers/sync.ts",
	"package.json",
	"tsconfig.json",
];

// Program definitions: manifest → entry + modules
interface ProgramDef {
	prefix: string;
	name: string;
	commands: Record<string, string>;
	entry: string;
	modules: Record<string, string>; // filename → relative file path
}

const PROGRAMS: ProgramDef[] = [
	{
		prefix: "/ttt",
		name: "Tic-Tac-Toe",
		commands: {
			new: "Start a new game",
			board: "Show the board",
			move: "Make a move",
			history: "Move-by-move replay",
		},
		entry: "ttt.ts",
		modules: { "ttt.ts": "src/programs/handlers/ttt.ts" },
	},
	{
		prefix: "/chat",
		name: "Chat",
		commands: {
			new: "Create a chat room",
			send: "Send a message",
			read: "Read messages",
			reply: "Reply to a message",
			react: "React to a message",
		},
		entry: "chat.ts",
		modules: { "chat.ts": "src/programs/handlers/chat.ts" },
	},
	{
		prefix: "/agent",
		name: "Agent",
		commands: {
			new: "Create an agent",
			ask: "Chat with agent",
			history: "Conversation history",
			config: "Set model/system/name",
			read: "Peek at agent conversation",
			inject: "Inject context from another agent",
		},
		entry: "agent.ts",
		modules: { "agent.ts": "src/programs/handlers/agent.ts" },
	},
	{
		prefix: "/gc",
		name: "Garbage Collection",
		commands: {
			run: "Run garbage collection",
			policies: "Show retention policies",
			set: "Update retention policy",
			protect: "Protect object from GC",
			stats: "Show GC statistics",
		},
		entry: "gc.ts",
		modules: { "gc.ts": "src/programs/handlers/gc.ts" },
	},
	{
		prefix: "/accounts",
		name: "Accounts & Permissions",
		commands: {
			whoami: "Show current user",
			login: "Login as user",
			logout: "Logout",
			create: "Create account",
			list: "List all accounts",
			grant: "Grant permission",
			revoke: "Revoke permission",
			check: "Check permission",
		},
		entry: "accounts.ts",
		modules: { "accounts.ts": "src/programs/handlers/accounts.ts" },
	},
	{
		prefix: "/sync",
		name: "P2P Sync",
		commands: {
			discover: "Start peer discovery",
			peers: "List known peers",
			sync: "Sync object with peers",
			broadcast: "Broadcast changes",
			add: "Add peer manually",
			remove: "Remove peer",
			status: "Show sync status",
		},
		entry: "sync.ts",
		modules: { "sync.ts": "src/programs/handlers/sync.ts" },
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

	// Build lookup of existing objects by type+name for idempotency.
	const existingByKey = new Map<string, string>();
	try {
		const allRefs = await store.list() as { id: string; typeKey: string }[];
		for (const ref of allRefs) {
			const obj = await store.get(ref.id) as { fields?: Record<string, any> } | null;
			if (!obj?.fields?.name?.stringValue) continue;
			// Key: "type::name" for source files, "type::prefix" for programs
			existingByKey.set(`${ref.typeKey}::${obj.fields.name.stringValue}`, ref.id);
			if (obj.fields.prefix?.stringValue) {
				existingByKey.set(`program::${obj.fields.prefix.stringValue}`, ref.id);
			}
		}
	} catch {
		// Store may be empty or not ready; proceed with creates.
	}

	let created = 0;
	let skipped = 0;

	for (const relPath of SOURCES) {
		const absPath = resolve(projectRoot, relPath);
		const name = basename(relPath);
		const kind = kindOf(relPath);

		// Idempotency: skip if an object of this type+name already exists.
		if (existingByKey.has(`${kind}::${name}`)) {
			console.log(`  EXIST ${relPath.padEnd(28)} ${kind.padEnd(12)} ${existingByKey.get(`${kind}::${name}`)!.slice(0, 12)}...`);
			skipped++;
			continue;
		}

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
		if (existingByKey.has(`program::${prog.prefix}`)) {
			console.log(`  EXIST ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingByKey.get(`program::${prog.prefix}`)!.slice(0, 12)}...`);
			skipped++;
			continue;
		}

		// Load all module files and build the manifest
		const moduleEntries: Record<string, ReturnType<typeof stringVal>> = {};
		let allOk = true;
		for (const [filename, relPath] of Object.entries(prog.modules)) {
			const absPath = resolve(projectRoot, relPath);
			try {
				const raw = readFileSync(absPath);
				// Store module source as base64 in the manifest map
				moduleEntries[filename] = stringVal(raw.toString("base64"));
			} catch {
				console.log(`  SKIP  ${prog.prefix} (missing ${relPath})`);
				allOk = false;
				break;
			}
		}
		if (!allOk) { skipped++; continue; }

		const commandEntries: Record<string, ReturnType<typeof stringVal>> = {};
		for (const [k, v] of Object.entries(prog.commands)) {
			commandEntries[k] = stringVal(v);
		}

		const fieldsJson = JSON.stringify({
			name: stringVal(prog.name),
			prefix: stringVal(prog.prefix),
			commands: mapVal(commandEntries),
			manifest: mapVal({
				entry: stringVal(prog.entry),
				modules: mapVal(moduleEntries),
			}),
		});

		try {
			const id = await store.create("program", fieldsJson);
			console.log(`  OK    ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${id.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
			created++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR   ${prog.name} \u2014 ${msg}`);
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
