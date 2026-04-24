/**
 * Bootstrap — seed Glon with its own source files and programs.
 *
 * Each source file becomes a Glon object created through the store actor.
 * Programs (src/programs/handlers/*.ts) are created as type=program objects
 * with manifest fields mapping module filenames to source strings.
 *
 * Usage: npm run bootstrap / npx tsx src/bootstrap.ts
 */

import "./env.js"; // side-effect: load .env into process.env
import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { initDisk } from "./disk.js";
import { stringVal, intVal, mapVal } from "./proto.js";
import { resolveEndpoint } from "./endpoint.js";
const ENDPOINT = resolveEndpoint();

const SOURCES = [
	"proto/glon.proto",
	"src/proto.ts",
	"src/crypto.ts",
	"src/dag/change.ts",
	"src/dag/dag.ts",
	"src/disk.ts",
	"src/env.ts",
	"src/endpoint.ts",
	"src/index.ts",
	"src/bootstrap.ts",
	"src/client.ts",
	"src/programs/runtime.ts",
	"src/programs/handlers/help.ts",
	"src/programs/handlers/crud.ts",
	"src/programs/handlers/inspect.ts",
	"src/programs/handlers/ipc.ts",
	"src/programs/handlers/ttt.ts",
	"src/programs/handlers/chat.ts",
	"src/programs/handlers/agent.ts",
	"src/programs/handlers/task.ts",
	"src/programs/handlers/gc.ts",
	"src/programs/handlers/accounts.ts",
	"src/programs/handlers/sync.ts",
	"src/programs/handlers/graph.ts",
	"src/programs/handlers/peer.ts",
	"src/programs/handlers/holdfast.ts",
	"src/programs/handlers/discord.ts",
	"src/programs/handlers/remind.ts",
	"src/programs/handlers/web.ts",
	"src/programs/handlers/memory.ts",
	"src/programs/handlers/google.ts",
	"src/programs/handlers/shell.ts",
	"src/programs/handlers/auth.ts",
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
		prefix: "/help",
		name: "Help",
		commands: {
			"": "Show all available programs",
		},
		entry: "help.ts",
		modules: { "help.ts": "src/programs/handlers/help.ts" },
	},
	{
		prefix: "/crud",
		name: "CRUD Operations",
		commands: {
			create: "Create an object",
			list: "List objects",
			get: "Get object details",
			set: "Set a field value",
			delete: "Delete an object",
			search: "Search objects",
		},
		entry: "crud.ts",
		modules: { "crud.ts": "src/programs/handlers/crud.ts" },
	},
	{
		prefix: "/inspect",
		name: "DAG Inspector",
		commands: {
			history: "Object change history",
			change: "Inspect a change",
			heads: "Current DAG heads",
			changes: "List all changes",
			snapshot: "Create snapshot",
			sync: "Sync two objects",
			remote: "Push/pull remote",
			info: "Store info",
			disk: "Disk usage",
		},
		entry: "inspect.ts",
		modules: { "inspect.ts": "src/programs/handlers/inspect.ts" },
	},
	{
		prefix: "/ipc",
		name: "Inter-Process Comm",
		commands: {
			send: "Send a message",
			inbox: "View inbox",
			outbox: "View outbox",
			clear: "Clear messages",
		},
		entry: "ipc.ts",
		modules: { "ipc.ts": "src/programs/handlers/ipc.ts" },
	},
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
			"register-tool": "Register a tool (dispatches to another program)",
			"unregister-tool": "Remove a registered tool",
			tools: "List registered tools",
			status: "Show token usage + compaction state",
			compact: "Manually compact old conversation turns",
			"view-summary": "Show latest compaction summary in full",
			tree: "Render the spawn lineage tree rooted at this agent",
			"list-templates": "List builtin and DAG-defined agent templates",
			"create-template": "Create a new agent_template in the DAG",
			"delete-template": "Tombstone an agent_template by name or id",
			recall: "Re-inject a compacted block back into the agent's live context",
		},
		entry: "agent.ts",
		modules: { "agent.ts": "src/programs/handlers/agent.ts" },
	},
	{
		prefix: "/task",
		name: "Task (subagent spawning)",
		commands: {
			spawn: "Spawn one or more subagents from a JSON batch",
			status: "Show a spawned subagent's depth, parent, and submitted result",
			tree: "Render the spawn lineage tree rooted at an agent",
			cancel: "Request cancellation of a running subagent",
		},
		entry: "task.ts",
		modules: {
			"task.ts": "src/programs/handlers/task.ts",
			"agent.ts": "src/programs/handlers/agent.ts",
		},
	},
	{
		prefix: "/gc",
		name: "Garbage Collection",
		commands: {
			run: "Collect unprotected, unreachable objects",
			protect: "Protect object (transitive via links)",
			unprotect: "Remove protection",
			status: "Show protected roots and reachability",
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
	{
		prefix: "/graph",
		name: "Object Graph",
		commands: {
			links: "Show links for an object",
			traverse: "BFS graph traversal",
			neighbors: "Immediate neighbors with types",
		},
		entry: "graph.ts",
		modules: { "graph.ts": "src/programs/handlers/graph.ts" },
	},
	{
		prefix: "/peer",
		name: "Peer",
		commands: {
			add: "Add a peer (person, agent, service)",
			list: "List peers (filter by --kind / --trust)",
			get: "Show a peer's full record",
			trust: "Change a peer's trust level",
			set: "Set a peer field (display_name, email, notes, ...)",
			remove: "Tombstone a peer",
		},
		entry: "peer.ts",
		modules: { "peer.ts": "src/programs/handlers/peer.ts" },
	},
	{
		prefix: "/holdfast",
		name: "Holdfast",
		commands: {
			setup: "Bootstrap the harness (create agent + self peer)",
			say: "Principal talks to the agent from the shell",
			ingest: "Deliver a message from a peer on a source",
			status: "Show current agent + principal ids",
			"refresh-prompt": "Re-render default system prompt + re-wire tools",
		},
		entry: "holdfast.ts",
		modules: {
			"holdfast.ts": "src/programs/handlers/holdfast.ts",
			"agent.ts": "src/programs/handlers/agent.ts",
		},
	},
	{
		prefix: "/discord",
		name: "Discord",
		commands: {
			status: "Show bridge state (bot user, watermarks, channels cached)",
			send: "Send a DM to a peer (diagnostic)",
			poll: "Trigger a poll cycle now (diagnostic)",
		},
		entry: "discord.ts",
		modules: { "discord.ts": "src/programs/handlers/discord.ts" },
	},
	{
		prefix: "/remind",
		name: "Remind",
		commands: {
			schedule: "Schedule a future action",
			list: "List reminders (filter by --peer/--status/--channel/--before)",
			get: "Show a reminder's full record",
			cancel: "Cancel a pending reminder",
			tick: "Run the scheduler once now (diagnostic)",
		},
		entry: "remind.ts",
		modules: { "remind.ts": "src/programs/handlers/remind.ts" },
	},
	{
		prefix: "/web",
		name: "Web",
		commands: {
			status: "Show limits + SSRF policy",
			fetch: "GET a URL and print the body (diagnostic)",
			"get-text": "GET + decode as UTF-8 (diagnostic)",
			"get-json": "GET + parse JSON (diagnostic)",
		},
		entry: "web.ts",
		modules: { "web.ts": "src/programs/handlers/web.ts" },
	},
	{
		prefix: "/memory",
		name: "Memory",
		commands: {
			facts: "List pinned facts for an agent",
			milestones: "List milestones for an agent",
			get: "Show one milestone in full",
			digest: "System-prompt-ready memory digest",
			recall: "Scoped search over memory",
			"forget-fact": "Tombstone a fact (recoverable via object_history)",
		},
		entry: "memory.ts",
		modules: { "memory.ts": "src/programs/handlers/memory.ts" },
	},
	{
		prefix: "/google",
		name: "Google",
		commands: {
			status: "Probe gws binary reachability",
			agenda: "Calendar agenda (today/tomorrow/week/days)",
			triage: "Gmail unread inbox triage",
		},
		entry: "google.ts",
		modules: { "google.ts": "src/programs/handlers/google.ts" },
	},
	{
		prefix: "/shell",
		name: "Shell",
		commands: {
			exec: "Run a bash command in a persistent session",
			sessions: "List live shell sessions",
			kill: "Kill and discard a session",
		},
		entry: "shell.ts",
		modules: { "shell.ts": "src/programs/handlers/shell.ts" },
	},
	{
		prefix: "/auth",
		name: "Auth",
		commands: {
			login: "Run interactive OAuth, save token",
			status: "Show current credential, expiry",
			refresh: "Force a token refresh",
			logout: "Delete stored credentials",
		},
		entry: "auth.ts",
		modules: { "auth.ts": "src/programs/handlers/auth.ts" },
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
	const FORCE = process.argv.includes("--force");
	const projectRoot = resolve(import.meta.dirname ?? ".", "..");

	initDisk();

	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);

	console.log(FORCE ? "Bootstrapping Glon (force mode: existing objects will be updated)...\n" : "Bootstrapping Glon...\n");
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
	let updated = 0;
	let skipped = 0;

	for (const relPath of SOURCES) {
		const absPath = resolve(projectRoot, relPath);
		const name = basename(relPath);
		const kind = kindOf(relPath);

		// Idempotency: skip (or update on --force) if an object of this type+name already exists.
		const existingSourceId = existingByKey.get(`${kind}::${name}`);
		if (existingSourceId && !FORCE) {
			console.log(`  EXIST ${relPath.padEnd(28)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
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
			if (existingSourceId) {
				// Force-update: overwrite content and size/lines fields on the existing object.
				const actor = client.objectActor.getOrCreate([existingSourceId]);
				await actor.setContent(contentBase64);
				await actor.setFields(JSON.stringify({
					lines: intVal(lineCount),
					size: intVal(raw.byteLength),
				}));
				console.log(`  UPD   ${relPath.padEnd(28)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
				updated++;
			} else {
				const id = await store.create(kind, fieldsJson, contentBase64);
				console.log(`  OK    ${relPath.padEnd(28)} ${kind.padEnd(12)} ${id.slice(0, 12)}...`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR   ${relPath} — ${msg}`);
			skipped++;
		}
	}

	// ── Programs ────────────────────────────────────────────────
	console.log("\nSeeding programs...\n");

	for (const prog of PROGRAMS) {
		const existingProgId = existingByKey.get(`program::${prog.prefix}`);
		if (existingProgId && !FORCE) {
			console.log(`  EXIST ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}...`);
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
			if (existingProgId) {
				// Force-update: overwrite commands + manifest on the existing program object.
				const actor = client.objectActor.getOrCreate([existingProgId]);
				await actor.setFields(JSON.stringify({
					commands: mapVal(commandEntries),
					manifest: mapVal({
						entry: stringVal(prog.entry),
						modules: mapVal(moduleEntries),
					}),
				}));
				console.log(`  UPD   ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				updated++;
			} else {
				const id = await store.create("program", fieldsJson);
				console.log(`  OK    ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${id.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR   ${prog.name} — ${msg}`);
			skipped++;
		}
	}

	console.log(`\nDone. ${created} created, ${updated} updated, ${skipped} skipped.`);

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
