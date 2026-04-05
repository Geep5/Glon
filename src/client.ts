/**
 * Glon OS Shell
 *
 * The operating system's own command-line interface.
 * Connects to the running OS actors and interprets commands.
 *
 * Usage: npm run client
 */

import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { createInterface } from "node:readline";
import { readFromDisk, readRawFromDisk, diskStats, listOnDisk } from "./disk.js";

// ── ANSI helpers ──────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }

// ── Table formatter ───────────────────────────────────────────────

function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)),
	);
	const sep = widths.map(w => "─".repeat(w)).join("──");
	const hdr = headers.map((h, i) => dim(h.padEnd(widths[i]!))).join("  ");
	const body = rows
		.map(r => r.map((c, i) => c.padEnd(widths[i]!)).join("  "))
		.join("\n");
	return `${hdr}\n${dim(sep)}\n${body}`;
}

// ── Main ──────────────────────────────────────────────────────────

const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

async function main() {
	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);

	// Boot banner
	let info;
	try {
		info = await store.info();
	} catch (err) {
		console.error(red("Cannot connect to Glon OS at " + ENDPOINT));
		console.error(dim("Start the OS first: npm run dev"));
		process.exit(1);
	}

	console.log();
	console.log(cyan(bold("  GLON OS")));
	console.log(dim(`  ${info.totalObjects} objects · protobuf primitives · rivet actors`));
	console.log(dim(`  type ${bold("/help")} for commands`));
	console.log();

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: `${CYAN}glon${DIM}>${RESET} `,
		terminal: true,
	});


	// Queue commands so async handlers don't race
	let pending: Promise<void> = Promise.resolve();

	rl.prompt();

	rl.on("line", (line) => {
		pending = pending.then(() => handleLine(line));
	});

	async function handleLine(line: string) {
		const raw = line.trim();
		if (!raw) { rl.prompt(); return; }

		const cmd = raw.startsWith("/") ? raw.slice(1) : raw;
		const parts = cmd.split(/\s+/);
		const command = parts[0]?.toLowerCase() ?? "";
		const args = parts.slice(1);

		try {
			switch (command) {
				// ── /help ─────────────────────────────────────
				case "help":
				case "h":
				case "?":
					console.log([
						"",
						bold("  Objects"),
						`    ${cyan("/list")} ${dim("[kind]")}          list all objects`,
						`    ${cyan("/get")} ${dim("<id>")}             inspect an object`,
						`    ${cyan("/search")} ${dim("<query>")}       search by name`,
						`    ${cyan("/create")} ${dim("<kind> <name>")} create an object`,
						`    ${cyan("/delete")} ${dim("<id>")}          delete an object`,
						"",
						bold("  System"),
						`    ${cyan("/info")}                  system stats`,
						`    ${cyan("/kinds")}                 list object kinds`,
						`    ${cyan("/proto")}                 show the proto schema`,
						"",
						bold("  Disk"),
						`    ${cyan("/disk")}                  raw protobuf storage stats`,
						`    ${cyan("/dump")} ${dim("<id>")}             hex dump of protobuf bytes`,
						`    ${cyan("/cat")} ${dim("<id>")}              read file content from disk`,
						"",
						bold("  Shell"),
						`    ${cyan("/help")}                  this message`,
						`    ${cyan("/quit")}                  exit`,
						"",
					].join("\n"));
					break;

				// ── /list [kind] ──────────────────────────────
				case "list":
				case "ls": {
					const kind = args[0] || undefined;
					const refs = await store.list(kind);
					if (refs.length === 0) {
						console.log(dim("  (no objects)"));
					} else {
						const rows = refs.map(r => [
							cyan(String(r.kind)),
							String(r.name),
							dim(String(r.size) + "b"),
							dim(String(r.id)),
						]);
						console.log(table(
							["KIND", "NAME", "SIZE", "ID"],
							rows,
						));
						console.log(dim(`\n  ${refs.length} objects`));
					}
					break;
				}

				// ── /get <id> ─────────────────────────────────
				case "get":
				case "inspect": {
					const id = args.join(" ");
					if (!id) { console.log(yellow("  usage: /get <id>")); break; }
					const ref = await store.get(id);
					if (!ref) { console.log(red(`  not found: ${id}`)); break; }
					console.log(`  ${dim("id:")}    ${ref.id}`);
					console.log(`  ${dim("kind:")}  ${cyan(String(ref.kind))}`);
					console.log(`  ${dim("name:")}  ${ref.name}`);
					console.log(`  ${dim("size:")}  ${ref.size} bytes`);
					break;
				}

				// ── /search <query> ───────────────────────────
				case "search":
				case "find": {
					const query = args.join(" ");
					if (!query) { console.log(yellow("  usage: /search <query>")); break; }
					const results = await store.search(query);
					if (results.length === 0) {
						console.log(dim("  (no matches)"));
					} else {
						for (const ref of results) {
							console.log(`  ${cyan(String(ref.kind).padEnd(14))} ${ref.name}  ${dim(String(ref.id))}`);
						}
						console.log(dim(`\n  ${results.length} results`));
					}
					break;
				}

				// ── /create <kind> <name> ─────────────────────
				case "create":
				case "new": {
					const kind = args[0];
					const name = args.slice(1).join(" ");
					if (!kind || !name) {
						console.log(yellow("  usage: /create <kind> <name>"));
						break;
					}
					const id = await store.create({ kind, name });
					console.log(green(`  created ${id}`));
					break;
				}

				// ── /delete <id> ──────────────────────────────
				case "delete":
				case "rm": {
					const id = args.join(" ");
					if (!id) { console.log(yellow("  usage: /delete <id>")); break; }
					const ok = await store.delete(id);
					console.log(ok ? green(`  deleted ${id}`) : red(`  not found: ${id}`));
					break;
				}

				// ── /info ─────────────────────────────────────
				case "info":
				case "status": {
					const sysInfo = await store.info();
					console.log(`  ${dim("objects:")}  ${bold(String(sysInfo.totalObjects))}`);
					console.log(`  ${dim("store:")}    rivet actor + sqlite`);
					console.log(`  ${dim("format:")}   protobuf (glon.Object)`);
					if (sysInfo.byKind.length > 0) {
						console.log(`  ${dim("kinds:")}`);
						for (const { kind, cnt } of sysInfo.byKind) {
							console.log(`    ${cyan(kind)}: ${cnt}`);
						}
					}
					break;
				}

				// ── /kinds ────────────────────────────────────
				case "kinds": {
					const sysInfo = await store.info();
					for (const { kind, cnt } of sysInfo.byKind) {
						console.log(`  ${cyan(kind.padEnd(16))} ${cnt} objects`);
					}
					break;
				}

				// ── /proto ────────────────────────────────────
				case "proto":
				case "schema": {
					// The proto file is itself an object in the OS
					const ref = await store.get("proto:glon.proto");
					if (!ref) {
						console.log(dim("  proto schema not bootstrapped"));
						break;
					}
					// Read it from the filesystem since the store only has the ref
					const { readFileSync } = await import("node:fs");
					const { resolve, dirname } = await import("node:path");
					const { fileURLToPath } = await import("node:url");
					const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
					const content = readFileSync(resolve(root, "proto/glon.proto"), "utf-8");
					for (const line of content.split("\n")) {
						if (line.startsWith("//")) {
							console.log(dim(`  ${line}`));
						} else if (line.includes("message") || line.includes("enum")) {
							console.log(cyan(`  ${line}`));
						} else {
							console.log(`  ${line}`);
						}
					}
					break;
				}

				// ── /disk ─────────────────────────────────────────
				case "disk":
				case "storage": {
					const stats = diskStats();
					console.log(`  ${dim("path:")}     ${stats.path}`);
					console.log(`  ${dim("objects:")}  ${bold(String(stats.objectCount))} .pb files`);
					console.log(`  ${dim("size:")}     ${stats.totalBytes} bytes (raw protobuf)`);
					console.log(`  ${dim("format:")}   protobuf wire format (binary)`);
					break;
				}

				// ── /dump <id> ────────────────────────────────────
				case "dump":
				case "hex": {
					const dumpId = args.join(" ");
					if (!dumpId) { console.log(yellow("  usage: /dump <id>")); break; }
					const raw = readRawFromDisk(dumpId);
					if (!raw) { console.log(red(`  not on disk: ${dumpId}`)); break; }
					// Hex dump with offset and ASCII
					console.log(dim(`  ${raw.byteLength} bytes of raw protobuf:\n`));
					for (let off = 0; off < raw.byteLength; off += 16) {
						const slice = raw.slice(off, off + 16);
						const hex = Array.from(slice).map(b => b.toString(16).padStart(2, "0")).join(" ");
						const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
						console.log(`  ${dim(off.toString(16).padStart(4, "0"))}  ${hex.padEnd(48)}  ${dim(ascii)}`);
					}
					break;
				}

				// ── /cat <id> ─────────────────────────────────────
				case "cat":
				case "read": {
					const catId = args.join(" ");
					if (!catId) { console.log(yellow("  usage: /cat <id>")); break; }
					const obj = readFromDisk(catId);
					if (!obj) { console.log(red(`  not on disk: ${catId}`)); break; }
					const text = Buffer.from(obj.content).toString("utf-8");
					console.log(dim(`  ── ${obj.name} (${obj.kind}, ${obj.size}b) ──`));
					for (const line of text.split("\n")) {
						console.log(`  ${line}`);
					}
					break;
				}

				// ── /quit ─────────────────────────────────────
				case "quit":
				case "exit":
				case "q":
					console.log(dim("  bye"));
					rl.close();
					process.exit(0);
					break;

				// ── unknown ───────────────────────────────────
				default:
					console.log(yellow(`  unknown: ${command}`) + dim("  (type /help)"));
			}
		} catch (err) {
			console.error(red(`  error: ${err}`));
		}

		console.log();
		rl.prompt();
	}

	rl.on("close", () => {
		pending.then(() => {
			console.log(dim("\n  bye"));
			process.exit(0);
		});
	});
}

main();
