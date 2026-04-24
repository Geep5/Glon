/**
 * .env loader — import for side-effects from every Glon entry point.
 *
 * Reads KEY=VALUE pairs from ./.env in the current working directory
 * (if present) and populates `process.env`, without overriding values
 * already set by the shell. Zero dependencies: a `.env` is convenient,
 * an inline `ANTHROPIC_API_KEY=... npm run dev` still works.
 *
 * Grammar (intentionally minimal):
 *   - lines starting with `#` are comments
 *   - blank lines ignored
 *   - `KEY=value` (no quoting) — value is everything after the first `=`
 *   - `KEY="value"` or `KEY='value'` — surrounding quotes stripped
 *   - leading `export ` tolerated for shell-sourceable files
 *
 * Intentionally NOT supported: variable expansion (`${OTHER}`), multi-line
 * values. Use a shell wrapper if you need those.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parse(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice(7) : line;
		const eq = body.indexOf("=");
		if (eq <= 0) continue;
		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = body.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** Load .env from cwd if present. Shell-set values always win. */
export function loadEnv(path: string = resolve(process.cwd(), ".env")): void {
	if (!existsSync(path)) return;
	let source: string;
	try {
		source = readFileSync(path, "utf-8");
	} catch {
		return;
	}
	const parsed = parse(source);
	for (const [key, value] of Object.entries(parsed)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

loadEnv();
