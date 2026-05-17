/**
 * Legacy shim — see ../proto.ts. AH window doesn't use this.
 */

export interface ObjectState {
	object: { id: string; typeKey?: string; name?: string };
	fields: Map<string, unknown>;
	blocks: Map<string, unknown>;
	heads: string[];
	deleted: boolean;
}

export function computeState(_changes: unknown[]): ObjectState {
	return { object: { id: "" }, fields: new Map(), blocks: new Map(), heads: [], deleted: false };
}

export function getPrimaryContent(_state: ObjectState): unknown {
	return null;
}
