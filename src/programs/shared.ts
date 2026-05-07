/**
 * Shared utilities for program handlers — ANSI styling and typed field extractors.
 *
 * Goal: remove the ~25 lines of ANSI constants duplicated across every handler
 * and replace raw `obj.fields.foo?.stringValue` access with typed getters that
 * handle both Record<string, Value> and Map<string, Value> shapes.
 */

import type { Value, ObjectLink } from "../proto.js";

// ── ANSI styling ─────────────────────────────────────────────────

const CODES = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
} as const;

function wrap(code: string) {
	return (s: string) => `${code}${s}${CODES.reset}`;
}

export const style = {
	dim: wrap(CODES.dim),
	bold: wrap(CODES.bold),
	italic: wrap(CODES.italic),
	underline: wrap(CODES.underline),
	cyan: wrap(CODES.cyan),
	green: wrap(CODES.green),
	red: wrap(CODES.red),
	yellow: wrap(CODES.yellow),
	blue: wrap(CODES.blue),
	magenta: wrap(CODES.magenta),
	white: wrap(CODES.white),
	gray: wrap(CODES.gray),
} as const;

// Convenience re-exports for single-character renames in existing files
export const dim = style.dim;
export const bold = style.bold;
export const italic = style.italic;
export const underline = style.underline;
export const cyan = style.cyan;
export const green = style.green;
export const red = style.red;
export const yellow = style.yellow;
export const blue = style.blue;
export const magenta = style.magenta;
export const white = style.white;
export const gray = style.gray;

// ── Field extractors ─────────────────────────────────────────────

/** Object fields come back from the store as plain objects; ObjectState uses a Map.
 *  Both shapes appear in the codebase, so extractors accept either. */
export type FieldContainer = Record<string, Value> | Map<string, Value> | undefined | null;

function rawValue(container: FieldContainer, key: string): unknown {
	if (!container) return undefined;
	if (container instanceof Map) {
		return container.get(key);
	}
	return (container as Record<string, unknown>)[key];
}

/** Return the Value wrapper, or undefined if the key is absent. */
export function getValue(container: FieldContainer, key: string): Value | undefined {
	const v = rawValue(container, key);
	if (v === undefined || v === null) return undefined;
	// Sometimes fields are stored as raw primitives (e.g. from JSON round-trips).
	// Wrap them back into a Value shape so downstream code stays uniform.
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "number") return Number.isInteger(v) ? { intValue: v } : { floatValue: v };
	if (typeof v === "boolean") return { boolValue: v };
	if (v instanceof Uint8Array) return { bytesValue: v };
	return v as Value;
}

export function getString(container: FieldContainer, key: string, fallback = ""): string {
	const v = getValue(container, key);
	if (!v) return fallback;
	if (v.stringValue !== undefined) return v.stringValue;
	if (typeof v === "string") return v;
	return fallback;
}

export function getInt(container: FieldContainer, key: string, fallback = 0): number {
	const v = getValue(container, key);
	if (!v) return fallback;
	if (v.intValue !== undefined) return v.intValue;
	if (typeof v === "number") return Number.isInteger(v) ? v : fallback;
	const parsed = parseInt(String(v.stringValue ?? v), 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function getFloat(container: FieldContainer, key: string, fallback = 0): number {
	const v = getValue(container, key);
	if (!v) return fallback;
	if (v.floatValue !== undefined) return v.floatValue;
	if (v.intValue !== undefined) return v.intValue;
	if (typeof v === "number") return v;
	const parsed = parseFloat(String(v.stringValue ?? v));
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function getBool(container: FieldContainer, key: string, fallback = false): boolean {
	const v = getValue(container, key);
	if (!v) return fallback;
	if (v.boolValue !== undefined) return v.boolValue;
	if (typeof v === "boolean") return v;
	return fallback;
}

export function getBytes(container: FieldContainer, key: string, fallback?: Uint8Array): Uint8Array | undefined {
	const v = getValue(container, key);
	if (!v) return fallback;
	if (v.bytesValue !== undefined) return v.bytesValue;
	if (v instanceof Uint8Array) return v;
	return fallback;
}

export function getLink(container: FieldContainer, key: string): ObjectLink | undefined {
	const v = getValue(container, key);
	if (!v) return undefined;
	if (v.linkValue) return v.linkValue;
	return undefined;
}

export function getLinkTargetId(container: FieldContainer, key: string, fallback = ""): string {
	return getLink(container, key)?.targetId ?? fallback;
}

/** Extract a string array from a ValueList or a plain string array. */
export function getStringArray(container: FieldContainer, key: string): string[] {
	const v = getValue(container, key);
	if (!v) return [];
	if (v.valuesValue?.items) {
		return v.valuesValue.items
			.map((item) => item.stringValue)
			.filter((s): s is string => s !== undefined);
	}
	if (v.listValue?.values) return v.listValue.values;
	if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
	return [];
}

/** Extract a string→string map from a ValueMap. */
export function getStringMap(container: FieldContainer, key: string): Map<string, string> {
	const v = getValue(container, key);
	if (!v) return new Map();
	const entries: Record<string, Value> | undefined =
		v.mapValue?.entries ?? (v as unknown as Record<string, Value>);
	if (!entries || typeof entries !== "object") return new Map();
	const out = new Map<string, string>();
	for (const [k, val] of Object.entries(entries)) {
		if (val && typeof val === "object" && "stringValue" in val) {
			out.set(k, String(val.stringValue));
		} else if (typeof val === "string") {
			out.set(k, val);
		}
	}
	return out;
}

/** Extract a raw nested map of Values (for program-defined structures). */
export function getMap(container: FieldContainer, key: string): Record<string, Value> | undefined {
	const v = getValue(container, key);
	if (!v) return undefined;
	return v.mapValue?.entries ?? (v as unknown as Record<string, Value>);
}


/** Extract a list of Values. */
export function getList(container: FieldContainer, key: string): Value[] {
	const v = getValue(container, key);
	if (!v) return [];
	return v.valuesValue?.items ?? [];
}
