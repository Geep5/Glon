// Coin x402 payment authorization helpers.
//
// Pure functions for constructing, canonicalising, and verifying x402
// PaymentPayload authorizations.  The async settlement logic that
// actually builds spend/create Changes lives in coin.ts because it is
// tightly coupled to the UTXO coin model.

import { hexDecode } from "../../crypto.js";
import { verify as ed25519Verify } from "../../det/ed25519.js";

export interface X402Authorization {
	scheme: "exact";
	network: "glon:v1";
	from: string;
	to: string;
	value: string;
	asset: string;
	validAfter: number;
	validBefore: number;
	nonce: string;
}

export function canonicalAuthBytes(auth: X402Authorization): Uint8Array {
	const sorted = {
		asset: auth.asset,
		from: auth.from,
		network: auth.network,
		nonce: auth.nonce,
		scheme: auth.scheme,
		to: auth.to,
		validAfter: auth.validAfter,
		validBefore: auth.validBefore,
		value: auth.value,
	};
	return new TextEncoder().encode(JSON.stringify(sorted));
}

export function verifyX402Auth(auth: X402Authorization, signatureHex: string): boolean {
	const msg = canonicalAuthBytes(auth);
	const sig = hexDecode(signatureHex);
	const pubkey = hexDecode(auth.from);
	if (sig.length !== 64 || pubkey.length !== 32) return false;
	return ed25519Verify(pubkey, msg, sig);
}
