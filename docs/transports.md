# Transport-Agnostic Glon Networking

## Overview

Glon's transport layer is completely agnostic to how bytes move between instances. Any transport that can move a protobuf `TransportEnvelope` from one node to another is valid. The system is built on three principles:

1. **Fail-fast delivery** — transports throw on failure; callers handle retry
2. **Idempotent import** — the kernel deduplicates changes by content hash
3. **Identity in signatures** — trust is in Ed25519 signatures, not transport metadata

## Architecture

```
┌─────────────┐     send()      ┌─────────────┐     ┌─────────────┐
│  /coin send │ ───────────────>│  transport  │────>│  remote     │
│  (builds    │  TransportEnvelope  │  (file/     │     │  inbox      │
│   bundle)   │                 │   discord/   │     └─────────────┘
└─────────────┘                 │   http)      │
                                └─────────────┘
                                       ▲
                                       │ inbox_drain()
                                ┌─────────────┐
                                │  transport- │
                                │  router     │
                                │  (polls all │
                                │   transports│
                                └─────────────┘
                                       │
                                       ▼ dispatch by content_type
                                ┌─────────────┐
                                │  content    │
                                │  handler    │
                                │  registry   │
                                └─────────────┘
```

## Core Types

### TransportEnvelope

```protobuf
message TransportEnvelope {
  string content_type = 1;        // e.g. "glon/change-bundle", "glon/text"
  bytes payload = 2;              // content-type-specific bytes
  bytes sender_pubkey = 3;        // optional convenience for receiver lookup
  map<string, string> metadata = 4;
}
```

### ChangeBundle

```protobuf
message ChangeBundle {
  repeated bytes changes = 1;     // each is a serialized Change proto
}
```

Bundles are transient wrappers. They have no id or hash — the Changes inside are individually content-addressed.

## Content Handler Registry

Programs register handlers for `content_type` values:

```typescript
import { registerContentHandler } from "../runtime.js";

registerContentHandler("glon/change-bundle", async (envelope, ctx) => {
  const bundle = decodeChangeBundle(envelope.payload);
  for (const changeBytes of bundle.changes) {
    const change = decodeChange(changeBytes);
    const actor = ctx.objectActor(change.objectId, { createWithInput: { id: change.objectId } });
    await actor.pushChanges(Buffer.from(changeBytes).toString("base64"));
  }
  return true;
});
```

Built-in handlers:
- `glon/change-bundle` — imports each Change via `objectActor.pushChanges`
- `glon/text` — logs to stdout (extend to route to agent inbox)

## Transports

### transport-file (test/localhost)

Address: `file:///path/to/inbox`

Writes raw protobuf `TransportEnvelope` to `.glonenv` files. Used for local testing and as the reference implementation.

```bash
# Set custom paths
export GLON_TRANSPORT_FILE_OUTBOX=/tmp/glon-out
export GLON_TRANSPORT_FILE_INBOX=/tmp/glon-in
```

### transport-discord

Address: `discord://<user_id>`

Sends payloads as Discord DMs via the existing `/discord` program. Payloads > 2000 chars are chunked. Inbound messages are handled by the Discord gateway listener in `/discord`.

### transport-http

Address: `https://host:port/path`

POSTs a JSON envelope. The recipient must expose an HTTP endpoint that accepts the payload and forwards it to their local transport-router.

## /coin send

The primary user of the transport layer. Builds a `ChangeBundle` containing:
- Spend changes for each input coin
- Create changes for outputs (recipient + change)
- Bucket genesis if creating a new output bucket

Then sends via the recipient peer's preferred transport.

```typescript
const result = await dispatchProgram("/coin", "send", [{
  recipient_peer_id: "...",
  token_id: "...",
  amount: "1000",
  transport: "/transport-file", // optional override
}]);
// { delivery_id: string, bundle_size: number }
```

## Peer Schema

Peers carry transport-relevant fields:

| Field | Purpose |
|-------|---------|
| `identity_pubkey` | Ed25519 pubkey for signature verification |
| `endpoints` | Comma-separated transport addresses |
| `preferred_transport` | Default transport program prefix |
| `key_verified_at` | ISO timestamp of last verification |
| `attestations` | JSON array of trust attestations |

## Security Model

- **Encryption is out of scope for v1** — envelopes are plaintext
- **Trust is in signatures** — every Change is signed by its author's Ed25519 key
- **Transport metadata is untrusted** — `sender_pubkey` in the envelope is a hint; actual verification uses the signatures on each Change
- **No replay protection at transport level** — idempotency is handled by the kernel's content-addressed import

## Future Work

- [ ] Encrypted envelopes (NaCl box)
- [ ] Transport retry with exponential backoff
- [ ] Multi-hop routing
- [ ] Bandwidth-adaptive chunking
