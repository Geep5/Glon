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
	import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
	import { resolve, basename, extname, relative } from "node:path";
	import { initDisk } from "./disk.js";
	import { stringVal, intVal, mapVal } from "./proto.js";
	import { resolveEndpoint } from "./endpoint.js";
const ENDPOINT = resolveEndpoint();

	// ── Auto-discovery ──────────────────────────────────────────────

	/** Walk a directory recursively, calling fn for every file. */
	function walkDir(dir: string, fn: (path: string) => void): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				walkDir(abs, fn);
			} else if (entry.isFile()) {
				fn(abs);
			}
		}
	}

	/** Whether a relative path should be bootstrapped as a source object. */
	function isSourceFile(relPath: string): boolean {
		const ext = extname(relPath);
		if (![".ts", ".js", ".proto", ".json"].includes(ext)) return false;
		if (relPath.includes(".test.")) return false;
		if (relPath.includes(".spec.")) return false;
		if (relPath.includes("node_modules")) return false;
		return true;
	}

	/** Discover all source files under src/, proto/, scripts/. */
	function discoverSources(root: string): string[] {
		const sources: string[] = [];
		for (const dir of ["src", "proto", "scripts"]) {
			const absDir = resolve(root, dir);
			if (!existsSync(absDir)) continue;
			walkDir(absDir, (absPath) => {
				const rel = relative(root, absPath);
				if (isSourceFile(rel)) sources.push(rel);
			});
		}
		for (const f of ["package.json", "tsconfig.json"]) {
			if (existsSync(resolve(root, f))) sources.push(f);
		}
		return [...new Set(sources)].sort();
	}

	/** Title-case a kebab/snake filename into a display name. */
	function titleCase(s: string): string {
		return s
			.replace(/[-_]/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	/** Extract command names + descriptions from a handler source file. */
	function extractCommands(content: string, _prefix: string): Record<string, string> {
		const commands: Record<string, string> = {};

		// Find switch (cmd) blocks and extract case literals.
		const switchRegex = /switch\s*\(\s*cmd\s*\)\s*\{/g;
		let switchMatch: RegExpExecArray | null;
		while ((switchMatch = switchRegex.exec(content)) !== null) {
			const startIdx = switchMatch.index + switchMatch[0].length;
			let braceCount = 1;
			let endIdx = startIdx;
			while (braceCount > 0 && endIdx < content.length) {
				if (content[endIdx] === "{") braceCount++;
				else if (content[endIdx] === "}") braceCount--;
				endIdx++;
			}
			const block = content.slice(startIdx, endIdx - 1);

			const caseRegex = /case\s+"([^"]+)":/g;
			let caseMatch: RegExpExecArray | null;
			while ((caseMatch = caseRegex.exec(block)) !== null) {
				const cmd = caseMatch[1];
				if (cmd === "default") continue;

				// Look for a comment immediately before this case.
				const before = block.slice(0, caseMatch.index);
				const lines = before.split("\n");
				let description = cmd;
				for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
					const line = lines[i].trim();
					if (line.startsWith("//")) {
						const comment = line.replace(/^\/\/\s*/, "").trim();
						// Prefer descriptive text after an em-dash or hyphen.
						if (comment.includes("—")) {
							const parts = comment.split("—");
							if (parts.length >= 2) {
								description = parts.slice(1).join("—").trim();
								break;
							}
						}
						if (comment.includes(" - ")) {
							const parts = comment.split(" - ");
							if (parts.length >= 2) {
								description = parts.slice(1).join(" - ").trim();
								break;
							}
						}
						// Fall back to the whole comment if it looks descriptive.
						if (!comment.startsWith("/") && comment.length > 2) {
							description = comment;
							break;
						}
					}
				}
				commands[cmd] = description;
			}
		}

		return commands;
	}

	/** Discover additional modules by scanning relative imports. */
	function discoverModules(root: string, entryFile: string, content: string): Record<string, string> {
		const modules: Record<string, string> = {
			[entryFile]: `src/programs/handlers/${entryFile}`,
		};
		const importRegex = /from\s+["']\.\/([^"']+)["']/g;
		let match: RegExpExecArray | null;
		while ((match = importRegex.exec(content)) !== null) {
			const imported = match[1];
			const importedBase = imported.endsWith(".js")
				? imported.replace(/\.js$/, ".ts")
				: imported + ".ts";
			const importedPath = `src/programs/handlers/${importedBase}`;
			if (existsSync(resolve(root, importedPath)) && !modules[importedBase]) {
				modules[importedBase] = importedPath;
			}
		}
		return modules;
	}

	/** Build program metadata by scanning handler source files. */
	function discoverPrograms(root: string): ProgramDef[] {
		const handlersDir = resolve(root, "src/programs/handlers");
		if (!existsSync(handlersDir)) return [];

		const entries = readdirSync(handlersDir, { withFileTypes: true });
		const files = entries
			.filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test."))
			.map((e) => e.name);

		return files
			.filter((file) => {
				const absPath = resolve(handlersDir, file);
				const content = readFileSync(absPath, "utf-8");
				// Only treat files that export a default program as programs.
				// Helper modules imported by programs are discovered via discoverModules.
				return /export\s+default\s+/.test(content);
			})
			.map((file) => {
				const base = file.replace(/\.ts$/, "");
				const absPath = resolve(handlersDir, file);
				const content = readFileSync(absPath, "utf-8");
				const prefix = `/${base}`;
				const name = titleCase(base);
				const commands = extractCommands(content, prefix);
				const modules = discoverModules(root, file, content);

				return {
					prefix,
					name,
					commands,
					entry: file,
					modules,
				};
			});
	}


	// Program definitions: manifest → entry + modules
	interface ProgramDef {
		prefix: string;
		name: string;
		commands: Record<string, string>;
		entry: string;
		modules: Record<string, string>; // filename → relative file path
	}

	const projectRoot = resolve(import.meta.dirname ?? ".", "..");
	const SOURCES = discoverSources(projectRoot);
	const PROGRAMS = discoverPrograms(projectRoot);

	const KIND_MAP: Record<string, string> = {
		".proto": "proto",
		".ts": "typescript",
		".js": "javascript",
		".json": "json",
	};

function kindOf(file: string): string {
	return KIND_MAP[extname(file)] ?? "unknown";
}

// Canonicalize a fields object so insertion-order doesn't change equality.
// Used by the bootstrap loop to compare desired vs stored shapes byte-for-byte.
function canonicalFields(value: unknown): string {
	return JSON.stringify(value, function sortKeys(_k, v) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
			return sorted;
		}
		return v;
	});
}

async function main() {
	const FORCE = process.argv.includes("--force");

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

		const existingSourceId = existingByKey.get(`${kind}::${name}`);

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

		// Content-aware idempotency: skip only when the on-disk content matches
		// what's already stored. --force rewrites unconditionally (useful when
		// you've manually corrupted an object and want a clean reseed).
		if (existingSourceId && !FORCE) {
			const existing = await store.get(existingSourceId);
			const existingContent = String(existing?.content ?? "");
			if (existingContent === contentBase64) {
				console.log(`  UNCHANGED ${relPath.padEnd(24)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
				skipped++;
				continue;
			}
		}

		try {
			if (existingSourceId) {
				const actor = client.objectActor.getOrCreate([existingSourceId]);
				await actor.setContent(contentBase64);
				await actor.setFields(JSON.stringify({
					lines: intVal(lineCount),
					size: intVal(raw.byteLength),
				}));
				const tag = FORCE ? "FORCED" : "UPDATE";
				console.log(`  ${tag.padEnd(9)} ${relPath.padEnd(24)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
				updated++;
			} else {
				const id = await store.create(kind, fieldsJson, contentBase64);
				console.log(`  CREATE    ${relPath.padEnd(24)} ${kind.padEnd(12)} ${id.slice(0, 12)}...`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR       ${relPath} \u2014 ${msg}`);
			skipped++;
		}
	}

	// ── Programs ────────────────────────────────────────────────
	console.log("\nSeeding programs...\n");

	for (const prog of PROGRAMS) {
		const existingProgId = existingByKey.get(`program::${prog.prefix}`);

		// Load all module files and build the manifest.
		const moduleEntries: Record<string, ReturnType<typeof stringVal>> = {};
		let allOk = true;
		for (const [filename, relPath] of Object.entries(prog.modules)) {
			const absPath = resolve(projectRoot, relPath);
			try {
				const raw = readFileSync(absPath);
				moduleEntries[filename] = stringVal(raw.toString("base64"));
			} catch {
				console.log(`  SKIP      ${prog.prefix} (missing ${relPath})`);
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

		// Content-aware idempotency: compare the full fields shape (commands +
		// manifest + name) against what's already stored. Only skip when nothing
		// changed; --force rewrites unconditionally.
		if (existingProgId && !FORCE) {
			const existing = await store.get(existingProgId);
			const existingFields = canonicalFields(existing?.fields);
			const desiredFields = canonicalFields(JSON.parse(fieldsJson));
			if (existingFields === desiredFields) {
				console.log(`  UNCHANGED ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}...`);
				skipped++;
				continue;
			}
		}

		try {
			if (existingProgId) {
				const actor = client.objectActor.getOrCreate([existingProgId]);
				await actor.setFields(JSON.stringify({
					commands: mapVal(commandEntries),
					manifest: mapVal({
						entry: stringVal(prog.entry),
						modules: mapVal(moduleEntries),
					}),
				}));
				const tag = FORCE ? "FORCED" : "UPDATE";
				console.log(`  ${tag.padEnd(9)} ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				updated++;
			} else {
				const id = await store.create("program", fieldsJson);
				console.log(`  CREATE    ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${id.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR       ${prog.name} \u2014 ${msg}`);
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
