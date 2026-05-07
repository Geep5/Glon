# x402 Payments Integration for Glon

## Goal

Add x402-standard payment protocol support to Glon so that:
1. Glon coins can be used as a payment method on the open web (any service that speaks x402 can accept Glon coins).
2. Glon agents can pay for and receive payment for HTTP resources using their native wallets.
3. glonAstrolabe can gate premium features with an x402 payment modal.

## Background

**x402** (github.com/x402-foundation/x402) is an HTTP-native payment standard. The flow:
1. Client requests a resource.
2. Server responds `402 Payment Required` with a `PAYMENT-REQUIRED` header containing base64-encoded `PaymentRequirements`.
3. Client selects a requirement, constructs a signed `PaymentPayload`, and resends the request with a `PAYMENT-SIGNATURE` header.
4. Server verifies the payload (locally or via a facilitator POST to `/verify`).
5. Server settles the payment (locally or via facilitator POST to `/settle`).
6. Server returns `200 OK` with the resource and a `PAYMENT-RESPONSE` header.

**Glon's crypto today:**
- Ed25519 keypairs in `~/.glon-data/wallet.json` (local-only).
- UTXO tokens: `chain.token` (metadata) + `chain.coin.bucket` (up to 1000 coins as blocks).
- Coin ops: `create {coin_id, owner_pubkey, amount}` and `spend {coin_id}`.
- Consensus enforces: signature validity, monotonic nonce per pubkey, asymmetric fees, semantic validation via `/coin.validate_op`.
- Atomic swaps already exist via `chain.coin.offer` (N-for-M trades).

Graice identified that Glon is ~90% of what's needed for x402. The missing pieces are:
- A signed authorization format (like EIP-3009 `transferWithAuthorization`).
- Unique nonce tracking per authorization (Glon uses monotonic nonces per Change; x402 needs unique nonces per auth).
- Time-bound validation (`validAfter` / `validBefore`).
- A `settle` action that consumes an authorization and creates spend changes.
- An HTTP transport endpoint so external services can accept Glon coins without knowing Glon internals.

---

## Architecture

### 1. Authorization Format (`chain.coin.authorization`)

A new signed struct, canonicalized and signed with the payer's Ed25519 key:

```json
{
  "from": "<ed25519-pubkey-hex>",
  "to": "<ed25519-pubkey-hex>",
  "value": "1000",
  "asset": "<token-id>",
  "validAfter": 1715126400,
  "validBefore": 1715126460,
  "nonce": "<32-byte-hex>"
}
```

- `from`: Payer's Ed25519 pubkey (hex).
- `to`: Recipient's Ed25519 pubkey (hex).
- `value`: Amount in the token's base units (string, like Glon's existing stringified bigints).
- `asset`: The `chain.token` object ID.
- `validAfter`: Unix timestamp (inclusive).
- `validBefore`: Unix timestamp (exclusive).
- `nonce`: 32-byte unique nonce (hex). NOT monotonic — just unique.

The payer signs the canonical hash of this struct. The signature is a detached Ed25519 signature (64 bytes, hex-encoded).

**Why not reuse Change signing?**
Changes are signed DAG mutations. An x402 authorization is a *delegation* — it authorizes a third party to later construct a spend Change. The semantics are different: the signer is not the Change author.

### 2. Nonce Tracking in Consensus

Current state (`PersistedState` in `consensus.ts`):
```ts
{ nonces: Map<pubkey_hex, uint64> }
```

We extend it with an authorization nonce store:
```ts
{
  nonces: Map<pubkey_hex, uint64>,           // monotonic nonces for Changes
  authNonces: Set<string>                     // seen authorization nonces (hex)
}
```

- On `settle`, the validator checks `authNonces.has(nonce)`.
- If unseen, it inserts and accepts.
- If seen, it rejects as replay.

**Storage concern:** A Set of every historical auth nonce grows unbounded. For v1, we accept this (authorizations are sparse compared to Changes). For v2, we can replace with a Bloom filter or a sparse Merkle tree. The plan documents this explicitly.

### 3. Time-Bound Validation

The validator checks `validAfter <= now < validBefore` where `now` is the validator's local clock at validation time.

- No block-height time in Glon v1; wall-clock is sufficient for payment authorizations.
- A small clock skew tolerance (e.g., 30 seconds) is acceptable and standard in x402.

### 4. New `/coin` Actions

#### `authorize` (CLI + actor)
Creates a signed x402 authorization. Lives in `/coin` because it constructs payment primitives.

```
/coin authorize <token_id> <amount> <to_pubkey> --valid-for=60s --nonce=random --key=<wallet_key>
```

Returns:
```json
{
  "authorization": { from, to, value, asset, validAfter, validBefore, nonce },
  "signature": "<hex>"
}
```

#### `settle` (CLI + actor)
Consumes a signed authorization and creates spend + create Changes on the payer's bucket.

```
/coin settle <authorization_json> <signature_hex> --key=<facilitator_key>
```

The facilitator key is used to sign the resulting Changes (the facilitator is the Change author, but the authorization signature proves payer consent).

Wait — this is a design tension. In Glon, the Change author must be the spender. But in x402, the facilitator settles on behalf of the payer.

**Resolution:** The `settle` action does not create Changes directly. Instead, it creates a *new Change on the payer's bucket* where the Change author is the payer (the payer's pubkey is the `author_pubkey`), and the authorization signature is attached as `author_sig`. The facilitator merely *submits* the Change to the network.

But this means the facilitator can't pay gas/fees on behalf of the payer in Glon's model. In Glon, fees are paid from the coin system itself (asymmetric fee burn), not gas.

**Simpler resolution:** The payer pre-signs a Change that spends their coins. The authorization IS the Change, just with a different payload structure that external verifiers can understand. The facilitator submits it.

Actually, let's look at this more carefully. In Glon, a Change on a bucket has:
- `author_pubkey`: Ed25519 pubkey of the signer
- `author_sig`: signature over canonical bytes
- `content`: blocks (coin ops)

For x402, we can define a new Change type or a new block content type that wraps an authorization. But the cleanest path is:

**The `settle` action creates a Change whose `author_pubkey` is the payer's pubkey, and whose `author_sig` is the authorization signature over a canonical representation of the spend intent.** The facilitator submits this Change. The kernel verifies the signature. The consensus validator checks the authorization nonce and time bounds.

This means the facilitator does not need their own key to sign the Change — they just broadcast the payer's pre-signed Change. This is true "gasless" from the facilitator's perspective (Glon has no gas, only fees, and fees are burned from the system, not paid by the submitter).

**Refined model:**
- The `authorize` command builds a *partial Change* (a Glon Change with `id` zeroed, containing spend/create blocks) and signs it. The output is the partial Change + signature.
- The `settle` command takes the partial Change + signature, fills in the `id` (content-addressed), and submits it via `objectActor.pushChange`.
- The consensus validator sees this as a normal chain-mode Change, but with an additional check: the nonce in the authorization must be unique, and the time bounds must be valid.

**But wait —** Glon's current consensus expects monotonic nonces. If we allow any nonce for authorization-based Changes, we break replay protection for normal Changes.

**Resolution:** We add a new type key or a marker in the Change that says "this Change is backed by an x402 authorization." The validator then switches nonce mode:
- Normal Changes: monotonic nonce check.
- Authorization-backed Changes: unique nonce check + time bounds.

The marker can be a new field `x402_auth` on the Change, or a new content type on the blocks. The cleanest is a new field `x402_auth: { nonce, valid_after, valid_before }` on the Change itself. If present, the validator uses the auth nonce rules.

### 5. New Chain-Mode Type: `chain.coin.settlement`

Actually, even cleaner: introduce a new object type `chain.coin.settlement` that records the authorization and its fulfillment. This is analogous to `chain.coin.offer`.

But x402 wants to be lightweight. The authorization itself is ephemeral. The settlement is just spend/create ops on buckets.

**Final design decision (keep it simple):**

Add an optional `x402` field to Change:
```ts
interface Change {
  // ... existing fields
  x402?: {
    nonce: string;        // 32-byte hex
    valid_after: number;  // unix seconds
    valid_before: number; // unix seconds
  };
}
```

If `x402` is present:
- `author_pubkey` is the payer.
- `author_sig` signs the canonical bytes of the Change (same as always).
- Consensus checks:
  1. Signature is valid (kernel does this).
  2. `x402.nonce` is not in `authNonces`.
  3. `x402.valid_after <= now < x402.valid_before`.
  4. Semantic validation of the spend/create ops (same as normal /coin validation).
- If all pass, insert nonce into `authNonces` and accept.

If `x402` is absent: existing monotonic nonce rules apply.

This means the `authorize` command builds a Change with the `x402` field set, the payer signs it, and the facilitator later submits it. The facilitator doesn't sign anything — they just broadcast.

### 6. HTTP Transport (Daemon Endpoint)

The daemon (`scripts/daemon.ts`) already exposes `POST /dispatch`. We add a new route tree:

```
GET  /x402/requirements?resource=<url>      -> Returns PaymentRequirements JSON
POST /x402/verify                           -> Verifies a PaymentPayload
POST /x402/settle                           -> Settles a PaymentPayload
```

Or, more x402-native, we make the daemon itself a **resource server** that can wrap other Glon endpoints. But the primary use case is:
- External services want to accept Glon coins.
- Those services run `@x402/express` middleware with a custom network config.
- The middleware POSTs to a Glon facilitator for verify/settle.

So Glon should expose a **facilitator** endpoint, not just a resource server endpoint.

**Facilitator API:**

```ts
POST /x402/facilitator/verify
Body: { payload: PaymentPayload, requirements: PaymentRequirements }
Response: { valid: boolean, error?: string }

POST /x402/facilitator/settle
Body: { payload: PaymentPayload, requirements: PaymentRequirements }
Response: { settled: boolean, txHash?: string, error?: string }
```

Wait, x402 uses base64 headers and standard HTTP codes. Let's align with the spec exactly.

Actually, the x402 spec says the resource server handles the 402 response and the headers. The facilitator is a separate service the resource server calls. Glon can run as a facilitator. The resource server would be any Express/Fastify app using `@x402/express`.

So we need a Glon facilitator package or endpoint that speaks the x402 facilitator protocol.

Looking at the x402 TypeScript SDK, facilitators implement:
- `verify(payload, requirements)` -> returns a verification result
- `settle(payload, requirements)` -> returns a settlement result

For Glon, the facilitator is a lightweight HTTP endpoint in the daemon:

```
POST /x402/verify
  Content-Type: application/json
  Body: { x402Version, payload, accepted }
  Response: 200 { valid: true } or 400 { valid: false, error }

POST /x402/settle
  Content-Type: application/json
  Body: { x402Version, payload, accepted }
  Response: 200 { settled: true, receipt } or 400 { settled: false, error }
```

But x402 actually uses a specific response format. Let me check the SDK more carefully...

From the spec, the facilitator endpoints are:
- `POST /verify` with `{ payload, requirements }`
- `POST /settle` with `{ payload, requirements }`

The response shape is network-dependent. For Glon, we'd define:

```ts
interface GlonVerifyResponse {
  valid: boolean;
  error?: string;
}

interface GlonSettleResponse {
  settled: boolean;
  receipt?: {
    changeIds: string[];  // The Change IDs created by settlement
  };
  error?: string;
}
```

### 7. Agent Tooling

Agents need tools to:
1. **Create authorizations** — e.g., "Authorize paying 100 FIG to api.example.com for the next 60 seconds."
2. **Check/settle incoming authorizations** — if the agent is a merchant.
3. **Query x402 requirements** — before making a paid API call.

New tools in `/holdfast` or `/agent`:
- `x402_authorize` — creates a signed authorization.
- `x402_settle` — settles an incoming authorization (if the agent is a facilitator/merchant).
- `x402_pay` — high-level tool: given a URL, fetches requirements, authorizes, and makes the paid request.

### 8. glonAstrolabe Integration

The 3D viewer can gate premium features behind x402:

**Use cases:**
- "Pay 10 FIG to unlock Planet Forge AI styling."
- "Pay 1 FIG to inject this compacted object back into context."
- "Pay 5 FIG to search across all agent histories."

**UI flow:**
1. User clicks a premium button.
2. Frontend fetches `/api/x402/requirements?resource=planet-forge&amount=10&asset=<token-id>`.
3. Frontend shows a payment modal with:
   - Amount + token
   - Recipient (astrolabe server's pubkey)
   - Validity period
   - "Sign & Pay" button
4. Frontend calls a new backend endpoint `POST /api/x402/authorize` which proxies to the Glon daemon to create the authorization.
5. Frontend sends the authorization to the astrolabe server.
6. Astrolabe server verifies (via Glon facilitator) and enables the feature.

**Alternatively**, the simpler path: astrolabe just acts as a resource server using `@x402/express` middleware, and the facilitator is the Glon daemon. The frontend uses `@x402/fetch` to make paid requests.

But `@x402/fetch` and `@x402/express` are EVM/SVM-specific. We'd need to build a `@x402/glon` package or at least custom middleware.

**Simpler v1 approach:**
- Add a payment modal to astrolabe's HTML/JS.
- The modal calls `POST /api/pay` which:
  1. Creates an x402 authorization via Glon's `/coin authorize`.
  2. Returns the authorization to the frontend.
  3. Frontend sends it back to astrolabe as proof of payment.
  4. Astrolabe calls Glon's `/coin settle` to actually execute the spend.
  5. On success, astrolabe enables the feature.

This is a closed loop within the Glon ecosystem. External x402 interoperability comes later via the facilitator endpoint.

---

## Implementation Phases

### Phase 1: Core Authorization + Settlement

**Files to modify:**
- `src/programs/handlers/coin.ts` — add `authorize` and `settle` CLI commands + actor actions.
- `src/programs/handlers/consensus.ts` — add `authNonces` set, time-bound validation, dual nonce mode.
- `src/det/canonical.ts` — ensure the `x402` field on Change is canonically encoded.
- `src/proto.ts` — add `x402` field to Change type.

**New files:**
- `src/programs/handlers/x402.ts` — HTTP facilitator endpoint (express route handler). Actually, better to add routes in `scripts/daemon.ts` since that's where HTTP lives.

**Tests:**
- `test/chain/x402.test.ts` — authorization creation, signature verification, settlement, replay protection, time bounds.

### Phase 2: Agent Tools

**Files to modify:**
- `src/programs/handlers/holdfast.ts` — add `x402_authorize`, `x402_pay` tools to the harness.
- `src/programs/handlers/agent.ts` — optionally add agent-level `x402` command.

### Phase 3: glonAstrolabe Payment Modal

**Files to modify (in `/home/geep/projekt/1/glonAstrolabe`):**
- `server/index.ts` — add `POST /api/pay/authorize` and `POST /api/pay/settle` endpoints.
- `public/index.html` — add payment modal markup.
- `public/js/main.js` — add modal open/close logic, wire premium buttons.
- `public/js/chat.js` — optionally add "tip agent" feature.

### Phase 4: External Interop (Facilitator)

**Files to modify:**
- `scripts/daemon.ts` — add `POST /x402/verify` and `POST /x402/settle` routes.
- New npm package (optional): `@x402/glon` — a tiny package that registers Glon as a network in the x402 SDK. This would live outside the glon repo.

---

## Detailed Design: Authorization + Settlement Flow

### Step 1: Payer creates authorization

```bash
/coin authorize <token_id> <amount> <recipient_pubkey> --valid-for=60 --key=default
```

1. Load payer's Ed25519 key from wallet.
2. Compute `validAfter = now`, `validBefore = now + validFor`.
3. Generate random 32-byte nonce.
4. Build a **partial Change** on the payer's bucket:
   - `typeKey`: `chain.coin.bucket`
   - `parentIds`: current bucket heads
   - `blocks`: `[spend(input_coin), create(output_coin for recipient), create(change_coin for payer)]`
   - `author_pubkey`: payer's pubkey
   - `x402`: `{ nonce, valid_after, valid_before }`
   - `author_sig`: null (id zeroed for signing)
5. Canonicalize and sign. The signature covers the canonical bytes of the partial Change.
6. Output the partial Change + signature.

### Step 2: Facilitator submits settlement

The facilitator (could be the merchant, a dedicated facilitator node, or the daemon) calls:

```bash
/coin settle <partial_change_json> <signature_hex>
```

1. Compute the content-addressed `id` of the Change (sha256 of canonical bytes with id zeroed).
2. Fill in `id` and `author_sig`.
3. Call `objectActor.pushChange(change)`.
4. The kernel verifies `author_sig` against `author_pubkey`.
5. The consensus validator:
   - Sees `x402` field present.
   - Checks `authNonces.has(nonce)` — reject if yes.
   - Checks `valid_after <= now < valid_before` — reject if no.
   - Dispatches to `/coin.validate_op` for semantic checks (sufficient balance, valid coin IDs).
   - If all pass: inserts nonce, accepts Change.
6. Coins are spent/created. Payer's balance decreases. Recipient's balance increases.

### Step 3: Merchant/resource server verifies

For external HTTP interop, the merchant uses a facilitator:

```
POST /x402/verify
{
  "payload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "glon:v1", "amount": "1000", "asset": "<token-id>", "payTo": "<recipient-pubkey>", "maxTimeoutSeconds": 60 },
    "payload": {
      "partialChange": { ... },
      "signature": "<hex>"
    }
  }
}
```

The facilitator:
1. Reconstructs the Change from `partialChange`.
2. Verifies signature.
3. Checks nonce is not in `authNonces`.
4. Checks time bounds.
5. Checks semantic validity (balance, etc.) by simulating the Change against current state.
6. Returns `{ valid: true }` or error.

### Step 4: Merchant settles

```
POST /x402/settle
{ same body }
```

The facilitator actually submits the Change to the DAG (same as `/coin settle`). Returns `{ settled: true, receipt: { changeIds: ["..."] } }`.

---

## Nonce Store Design

**v1 (simple Set):**
- `authNonces: Set<string>` in consensus actor state.
- RivetKit serializes Sets as arrays in JSON.
- On validator startup, load from actor state.
- On acceptance, add nonce.
- Tradeoff: unbounded growth. Mitigation: authorizations expire, so old nonces could be pruned. But pruning introduces complexity. For v1, accept growth.

**v2 (Bloom filter + periodic compaction):**
- Replace Set with a Bloom filter for probabilistic membership.
- False positives mean rare rejections of valid payments — acceptable for v2.
- Or use a sparse Merkle tree with epoch-based roots.

The plan documents v1 with a TODO for v2.

---

## Time Source

Consensus validator uses `Date.now() / 1000` for wall-clock time.
- Skew tolerance: 30 seconds (configurable).
- No blockchain time oracle in Glon v1. This is acceptable for payment authorizations because the authorization lifetime is short (seconds to minutes).

---

## Fee Model

Authorization-backed Changes pay the same fee as normal Changes (base fee × multiplier for the op kind).
- Who pays the fee? In Glon, fees are burned from the system, not collected by a miner. The Change itself carries the fee. Since the Change is signed by the payer, the fee is implicitly "paid" by the payer's economic stake in the system.
- This is actually cleaner than EVM gas: there's no separate gas token. The facilitator doesn't need gas money.

---

## Security Considerations

1. **Replay attacks:** Mitigated by unique nonce tracking.
2. **Double-spend:** Mitigated by consensus + DAG ordering. If two facilitators try to settle the same authorization concurrently, only one wins (first to be indexed).
3. **Time manipulation:** A facilitator with a skewed clock could settle an expired authorization. Mitigated by 30s tolerance and short authorization lifetimes.
4. **Facilitator front-running:** A malicious facilitator could censor or delay settlements. This is inherent to any pull-payment model. Mitigation: users can run their own facilitator.
5. **Authorization forgery:** Mitigated by Ed25519 signature verification in the kernel.

---

## Agent Use Cases

### Agent as Payer
An agent wants to call a paid API (e.g., a more powerful LLM, a data service):
```
agent: "I need to use the premium weather API. It costs 5 FIG."
(tool: x402_pay)
  -> Fetches 402 requirements
  -> Authorizes 5 FIG
  -> Makes paid request
  -> Receives data
```

### Agent as Merchant
An agent provides a service (e.g., "I'll analyze your codebase for 100 FIG"):
```
User: "Analyze my codebase"
Agent: "That will be 100 FIG. Please authorize payment."
(tool: x402_authorize with agent's pubkey as recipient)
User authorizes via Discord/web UI
Agent settles the authorization
Agent performs the work
```

### Agent Subscriptions
An agent subscribes to a daily news feed:
```
Agent authorizes 10 FIG/day for 30 days (as 30 separate authorizations or one reusable one)
Merchant settles daily
```

Reusable authorizations are not in v1. v1 is one-time only. v2 can add reusable delegations (ERC-7710 style).

---

## glonAstrolabe Payment Modal Design

### UI Placement
- **Planet Forge:** "Pay 10 FIG for AI styling" button.
- **Context Injection:** "Pay 1 FIG to recall this block" (if block is compacted).
- **Search:** "Pay 5 FIG for full-history search" (if search is rate-limited).
- **Agent Tipping:** In chat window, a "Tip 1 FIG" button.

### Modal Flow
1. User clicks premium action.
2. Modal appears showing:
   - Amount (e.g., 10 FIG)
   - Token name
   - Recipient (astrolabe server's display name)
   - Wallet balance (fetched from `/api/coins`)
   - "Valid for 60 seconds"
3. User clicks "Sign & Pay".
4. Frontend `fetch('/api/pay/authorize', { method: 'POST', body: { tokenId, amount, recipientPubkey, validFor } })`.
5. Backend calls Glon `/coin authorize` with the user's default wallet key.
6. Backend returns `{ authorization, signature }`.
7. Frontend `fetch('/api/pay/settle', { method: 'POST', body: { authorization, signature } })`.
8. Backend calls Glon `/coin settle`.
9. On success, backend returns `{ ok: true }`, frontend enables the feature.

### Wallet Selection
The astrolabe server reads `~/.glon-data/wallet.json` to list keys. The user selects which key to use. In v1, we can default to the first key.

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/proto.ts` | Add `x402` field to `Change` type |
| `src/det/canonical.ts` | Include `x402` in canonical encoding |
| `src/programs/handlers/consensus.ts` | Add `authNonces`, time-bound check, dual nonce mode |
| `src/programs/handlers/coin.ts` | Add `authorize`, `settle` commands and actor actions |
| `src/programs/handlers/wallet.ts` | Optionally add `signAuthorization` helper |
| `src/programs/handlers/holdfast.ts` | Add `x402_authorize`, `x402_pay` tools |
| `scripts/daemon.ts` | Add `/x402/verify`, `/x402/settle` HTTP routes |
| `test/chain/x402.test.ts` | New test file |
| `glonAstrolabe/server/index.ts` | Add `/api/pay/*` routes |
| `glonAstrolabe/public/index.html` | Add payment modal markup |
| `glonAstrolabe/public/js/main.js` | Wire modal, premium buttons |

---

## Open Questions

1. **Should the authorization be a DAG object?** Pro: audit trail, recallable. Con: overhead. Decision: No, authorizations are ephemeral. The settlement Change is the permanent record.
2. **Should facilitators charge a fee?** x402 facilitators typically take a small cut. Glon v1 facilitator is the user's own daemon, so no cut. External facilitators can be added later.
3. **Reusable authorizations?** Out of scope for v1. One-time only.
4. **Multi-asset authorizations?** x402 `exact` is single-asset. Glon offers are multi-asset. Keep them separate.
5. **Should `@x402/glon` be a separate npm package?** Yes, but out of scope for this repo. It would register Glon network support in the x402 TS SDK.

---

## Acceptance Criteria

- [ ] `/coin authorize` creates a valid signed authorization.
- [ ] `/coin settle` consumes an authorization and creates spend/create Changes.
- [ ] Consensus rejects duplicate authorization nonces.
- [ ] Consensus rejects authorizations outside their time bounds.
- [ ] Kernel signature verification works for authorization-backed Changes.
- [ ] Daemon exposes `/x402/verify` and `/x402/settle`.
- [ ] An agent can use `x402_pay` to make a paid HTTP request.
- [ ] glonAstrolabe can show a payment modal and process a payment end-to-end.
- [ ] All new code has unit tests.
