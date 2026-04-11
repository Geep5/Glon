/**
 * Program runtime — loads program objects from the store and dispatches
 * commands to their dynamically-evaluated handlers.
 *
 * Programs are Glon objects of type "program" whose content (ContentSet)
 * holds a JavaScript function body. The body receives (cmd, args, ctx)
 * as free variables via AsyncFunction constructor.
 */

import type { Value, Change, ObjectRef } from "../proto.js";

// ── AsyncFunction constructor ───────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
	...args: string[]
) => (...args: any[]) => Promise<any>;

// ── Types ───────────────────────────────────────────────────────

/** Typed context object passed to program handlers as `ctx`. */
export interface ProgramContext {
	// Rivet client for actor calls
	client: unknown;
	store: unknown;
	resolveId: (prefix: string) => Promise<string | null>;

	// Proto value constructors
	stringVal: (s: string) => Value;
	intVal: (n: number) => Value;
	floatVal: (n: number) => Value;
	boolVal: (b: boolean) => Value;
	mapVal: (entries: Record<string, Value>) => Value;
	listVal: (items: Value[]) => Value;
	displayValue: (v: Value) => string;

	// Disk (read-only)
	listChangeFiles: () => string[];
	readChangeByHex: (hex: string) => Change | null;
	hexEncode: (bytes: Uint8Array) => string;

	// Output
	print: (msg: string) => void;

	// Utils
	randomUUID: () => string;
}

/** A loaded program ready for dispatch. */
export interface ProgramEntry {
	prefix: string;
	name: string;
	commands: Record<string, string>;
	handler: (cmd: string, args: string[], ctx: ProgramContext) => Promise<void>;
}

// ── Field extraction helpers ────────────────────────────────────

/** Extract a plain string from a proto field that may be a raw string or a Value wrapper. */
function extractString(field: unknown): string | undefined {
	if (field == null) return undefined;
	if (typeof field === "string") return field;
	if (typeof field === "object" && "stringValue" in (field as any)) {
		return (field as any).stringValue as string;
	}
	return undefined;
}

/**
 * Extract a commands map from a field that is either:
 * - a plain Record<string, string>
 * - a proto Value with mapValue.entries containing Value wrappers
 */
function extractCommands(field: unknown): Record<string, string> {
	if (field == null) return {};
	// Proto Value shape: { mapValue: { entries: Record<string, Value> } }
	if (typeof field === "object" && "mapValue" in (field as any)) {
		const entries = (field as any).mapValue?.entries;
		if (!entries || typeof entries !== "object") return {};
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(entries)) {
			const s = extractString(val);
			if (s !== undefined) result[key] = s;
		}
		return result;
	}
	// Plain object of strings
	if (typeof field === "object") {
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(field as Record<string, unknown>)) {
			if (typeof val === "string") {
				result[key] = val;
			} else {
				const s = extractString(val);
				if (s !== undefined) result[key] = s;
			}
		}
		return result;
	}
	return {};
}

// ── Loader ──────────────────────────────────────────────────────

/**
 * Load all program objects from the store and compile their handlers.
 *
 * Skips programs that have no content or whose source fails to compile.
 */
export async function loadPrograms(
	store: { list: (...args: any[]) => any; get: (...args: any[]) => any },
	client: unknown,
): Promise<ProgramEntry[]> {
	const refs = await store.list("program");
	const programs: ProgramEntry[] = [];

	for (const ref of refs) {
		let obj: any;
		try {
			obj = await store.get(ref.id);
		} catch {
			continue;
		}
		if (!obj) continue;

		const fields: Record<string, unknown> = obj.fields ?? {};

		const prefix = extractString(fields.prefix);
		if (!prefix) continue; // program must have a prefix

		const name = extractString(fields.name) ?? prefix;
		const commands = extractCommands(fields.commands);

		// Content is base64-encoded source
		const contentB64: string | undefined = obj.content;
		if (!contentB64) continue;

		let source: string;
		try {
			source = Buffer.from(contentB64, "base64").toString("utf-8");
		} catch {
			continue;
		}
		if (!source.trim()) continue;

		// Compile handler
		let rawHandler: (cmd: string, args: string[], ctx: ProgramContext) => Promise<void>;
		try {
			rawHandler = new AsyncFunction("cmd", "args", "ctx", source) as any;
		} catch (err: any) {
			console.warn(`[program] Failed to compile "${name}" (${ref.id}): ${err.message}`);
			continue;
		}

		// Wrap in error boundary so a broken handler doesn't crash the shell
		const handler = async (cmd: string, args: string[], ctx: ProgramContext): Promise<void> => {
			try {
				await rawHandler(cmd, args, ctx);
			} catch (err: any) {
				ctx.print("Error: " + (err.message ?? String(err)));
			}
		};

		programs.push({ prefix, name, commands, handler });
	}

	return programs;
}

// ── Dispatcher ──────────────────────────────────────────────────

/**
 * Dispatch a raw command line to the matching program handler.
 *
 * Returns true if a program handled the input, false otherwise.
 */
export async function dispatchProgram(
	programs: ProgramEntry[],
	input: string,
	ctx: ProgramContext,
): Promise<boolean> {
	const tokens = input.split(/\s+/);
	const cmd = tokens[0];
	if (!cmd) return false;

	const allArgs = tokens.slice(1);

	const program = programs.find((p) => p.prefix === cmd);
	if (!program) return false;

	await program.handler(allArgs[0] ?? "", allArgs.slice(1), ctx);
	return true;
}
