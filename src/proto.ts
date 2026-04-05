/**
 * Proto layer — the primitive.
 *
 * Loads glon.proto at import time and exposes typed helpers for
 * creating, encoding, and decoding glon.Object messages.
 *
 * Every other module in Glon imports from here. Nothing else
 * defines data shapes. The .proto file is the single source of truth.
 */

import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = resolve(__dirname, "../proto/glon.proto");

// ── Load schema synchronously at startup ──────────────────────────

const root = protobuf.loadSync(PROTO_PATH);

const ObjectType = root.lookupType("glon.GlonObject");
const ObjectRefType = root.lookupType("glon.ObjectRef");
const EnvelopeType = root.lookupType("glon.Envelope");

// ── TypeScript interfaces mirroring the proto ─────────────────────

export interface GlonObject {
	id: string;
	kind: string;
	name: string;
	content: Uint8Array;
	meta: Record<string, string>;
	createdAt: number; // unix ms (protobuf int64 → number in JS)
	updatedAt: number;
	size: number;
}

export interface GlonObjectRef {
	id: string;
	kind: string;
	name: string;
	size: number;
}

export interface GlonEnvelope {
	fromId: string;
	toId: string;
	action: string;
	payload: Uint8Array;
	timestamp: number;
}

// ── JSON-safe state shape (for Rivet actor state persistence) ─────
// Rivet state must survive structuredClone. Uint8Array is fine, but
// we store content as base64 for readability in debugging/logging.

export interface ObjectState {
	id: string;
	kind: string;
	name: string;
	content: string; // base64-encoded bytes
	meta: Record<string, string>;
	createdAt: number;
	updatedAt: number;
	size: number;
}

// ── Envelope record (JSON-safe for actor state) ──────────────────

export interface EnvelopeRecord {
	fromId: string;
	toId: string;
	action: string;
	payload: string; // base64-encoded bytes, or plain text for simple messages
	timestamp: number;
}

/** Create an EnvelopeRecord with defaults. */
export function createEnvelope(
	fromId: string,
	toId: string,
	action: string,
	payload = "",
): EnvelopeRecord {
	return { fromId, toId, action, payload, timestamp: Date.now() };
}

// ── Encode / Decode ───────────────────────────────────────────────

/** Encode a GlonObject to protobuf wire bytes. */
export function encodeObject(obj: GlonObject): Uint8Array {
	const err = ObjectType.verify(obj);
	if (err) throw new Error(`proto verify: ${err}`);
	return ObjectType.encode(ObjectType.create(obj)).finish();
}

/** Decode protobuf wire bytes to a GlonObject. */
export function decodeObject(bytes: Uint8Array): GlonObject {
	const msg = ObjectType.decode(bytes);
	return ObjectType.toObject(msg, {
		bytes: Uint8Array,
		longs: Number,
		defaults: true,
	}) as unknown as GlonObject;
}

/** Encode a GlonObjectRef to protobuf wire bytes. */
export function encodeObjectRef(ref: GlonObjectRef): Uint8Array {
	return ObjectRefType.encode(ObjectRefType.create(ref)).finish();
}

/** Decode protobuf wire bytes to a GlonObjectRef. */
export function decodeObjectRef(bytes: Uint8Array): GlonObjectRef {
	const msg = ObjectRefType.decode(bytes);
	return ObjectRefType.toObject(msg, {
		defaults: true,
	}) as unknown as GlonObjectRef;
}

/** Encode a GlonEnvelope to protobuf wire bytes. */
export function encodeEnvelope(env: GlonEnvelope): Uint8Array {
	return EnvelopeType.encode(EnvelopeType.create(env)).finish();
}

/** Decode protobuf wire bytes to a GlonEnvelope. */
export function decodeEnvelope(bytes: Uint8Array): GlonEnvelope {
	const msg = EnvelopeType.decode(bytes);
	return EnvelopeType.toObject(msg, {
		bytes: Uint8Array,
		longs: Number,
		defaults: true,
	}) as unknown as GlonEnvelope;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Create a GlonObject from minimal input. Fills defaults. */
export function createObject(
	input: Pick<GlonObject, "id" | "kind" | "name"> &
		Partial<Omit<GlonObject, "id" | "kind" | "name">>,
): GlonObject {
	const now = Date.now();
	const content = input.content ?? new Uint8Array(0);
	return {
		id: input.id,
		kind: input.kind,
		name: input.name,
		content,
		meta: input.meta ?? {},
		createdAt: input.createdAt ?? now,
		updatedAt: input.updatedAt ?? now,
		size: input.size ?? content.byteLength,
	};
}

/** Convert GlonObject ↔ ObjectState (actor-safe representation). */
export function toState(obj: GlonObject): ObjectState {
	return {
		...obj,
		content: Buffer.from(obj.content).toString("base64"),
	};
}

export function fromState(state: ObjectState): GlonObject {
	const content = Buffer.from(state.content, "base64");
	return {
		...state,
		content: new Uint8Array(content),
	};
}

/** Create a ref from a full object. */
export function toRef(obj: GlonObject | ObjectState): GlonObjectRef {
	return { id: obj.id, kind: obj.kind, name: obj.name, size: obj.size };
}

/** Derive a stable ID from a kind + path/name. */
export function deriveId(kind: string, path: string): string {
	return `${kind}:${path}`;
}
