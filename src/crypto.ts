/**
 * Legacy shim — see proto.ts. AH window doesn't use this.
 */

export function hexEncode(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}
