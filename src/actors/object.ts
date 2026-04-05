/**
 * Object actor — the fundamental unit of Glon OS.
 *
 * Each instance IS an OS object. Its state is a protobuf glon.Object
 * serialized to the actor-safe ObjectState shape. Rivet persists it
 * durably: the object survives crashes, restarts, and hibernation.
 *
 * One actor per object. The actor IS the object.
 */

import { actor, event } from "rivetkit";
import type { ObjectState } from "../proto.js";
import { toState, fromState, createObject, toRef, encodeObject } from "../proto.js";

export interface ObjectInput {
	id: string;
	kind: string;
	name: string;
	content?: string; // base64
	meta?: Record<string, string>;
}

// Empty initial state — overridden by createState on first creation.
const EMPTY_STATE: ObjectState = {
	id: "",
	kind: "",
	name: "",
	content: "",
	meta: {},
	createdAt: 0,
	updatedAt: 0,
	size: 0,
};

export const objectActor = actor({

	createState: (_c, input: ObjectInput): ObjectState => {
		const content = input.content
			? new Uint8Array(Buffer.from(input.content, "base64"))
			: new Uint8Array(0);

		return toState(
			createObject({
				id: input.id,
				kind: input.kind,
				name: input.name,
				content,
				meta: input.meta ?? {},
			}),
		);
	},

	events: {
		changed: event<{ id: string; updatedAt: number }>(),
	},

	actions: {
		/** Return the full object state. */
		read: (c): ObjectState => {
			return c.state;
		},

		/** Return protobuf-encoded bytes as base64. */
		readProto: (c): string => {
			const obj = fromState(c.state);
			const bytes = encodeObject(obj);
			return Buffer.from(bytes).toString("base64");
		},

		/** Return just the content as UTF-8 text. */
		readContent: (c): string => {
			return Buffer.from(c.state.content, "base64").toString("utf-8");
		},

		/** Overwrite content. */
		write: (c, contentBase64: string) => {
			const bytes = Buffer.from(contentBase64, "base64");
			c.state.content = contentBase64;
			c.state.size = bytes.byteLength;
			c.state.updatedAt = Date.now();
			c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
		},

		/** Set a metadata key. */
		setMeta: (c, key: string, value: string) => {
			c.state.meta[key] = value;
			c.state.updatedAt = Date.now();
			c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
		},

		/** Get all metadata. */
		getMeta: (c): Record<string, string> => {
			return c.state.meta;
		},

		/** Return a lightweight ref (no content). */
		ref: (c) => {
			return toRef(c.state);
		},
	},
});
