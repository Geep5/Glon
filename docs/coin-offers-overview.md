# Coin Offers: Technical Overview

## What It Is

A peer-to-peer atomic token swap system built on glon's DAG kernel. Two parties trade tokens without a trusted intermediary — the settlement is either fully atomic or does not happen at all.

## Why Not Simple Transfers?

Alice wants to trade 1000 Token A for 500 Token B. If she sends first, Bob might not send back. If Bob sends first, Alice might not. An escrow-based offer lets both sides lock their tokens into a single object whose rules enforce "all or nothing."

## Object Model

### `chain.coin.offer`

Each offer is a single DAG object with these fields:

| Field | Type | Purpose |
|-------|------|---------|
| `maker_pubkey` | string | Creator of the offer (escrow depositor) |
| `terms` | JSON string | `{offered: [{tokenId, amount}], requested: [{tokenId, amount}]}` |
| `status` | string | Static snapshot: `open`, `funded`, `settled`, `cancelled` |

The live state is computed by **replaying** all blocks in the offer object.

### Replay State (`replayOffer`)

```
escrowed: Map<coin_id, {owner, amount, tokenId, spent}>
payments:  Map<coin_id, {owner, amount, tokenId, spent}>
outputs:   Map<coin_id, {owner, amount, tokenId}>
status:    "open" | "funded" | "settled" | "cancelled"
```

Two-pass replay is needed because `computeState` topologically sorts blocks, so `settle` may appear before `escrow`/`pay` in the sorted array.

## Operation Kinds

All ops use `contentType: "chain.coin.offer.op"`.

| Op | Who | Effect |
|----|-----|--------|
| `offer_escrow` | Maker | Deposits offered coins into the offer object. Status becomes `open`. |
| `offer_pay` | Taker | Deposits requested coins into the offer object. Status becomes `funded`. |
| `offer_settle` | Taker (or anyone) | Marks all escrowed and payment coins as `spent`, creates output coins in `outputs` map. Status becomes `settled`. |
| `offer_cancel` | Maker | Marks all escrowed coins as `spent`, creates refund outputs. Status becomes `cancelled`. |
| `spend` + `create` | Claimer | After settlement, each party spends their output coin from the offer and creates a matching coin in their own bucket. |

## The Accept Flow (End-to-End)

```
Maker:          offer_create(tokenA, 1000, tokenB, 500)
                   ↓
                [batch: bucket_spend(tokenA) + offer_genesis + offer_escrow(tokenA)]
                   ↓
Taker:          offer_accept(offer_id)
                   ↓
                ┌─────────────────────────────────────────────────────┐
                │  batch:                                              │
                │    1. bucket_spend(tokenB)  ← taker's payment        │
                │    2. offer_pay(tokenB)     ← deposit into offer     │
                │    3. offer_settle(outputs) ← define who gets what   │
                └─────────────────────────────────────────────────────┘
                   ↓
                pushChangesBatch([...])  ← all-or-nothing atomic write
                   ↓
Maker:          offer_claim(offer_id)  ← spend output, create in own bucket
Taker:          offer_claim(offer_id)  ← spend output, create in own bucket
```

## Cross-Object Batch Atomicity (`pushChangesBatch`)

The kernel's `storeActor.pushChangesBatch` accepts an array of `{objectId, changesBase64}` entries:

1. **Decode all changes** into `Change[]`.
2. **Group by objectId** — each object's changes are validated together.
3. **Signature gate per group** — each change must carry a valid `author_sig` with nonce > last_seen for that pubkey.
4. **Run validators with `BatchContext`** — every validator receives `allChanges: Change[]` so it can inspect cross-object references.
5. **Write all or reject all** — if any validator fails, no changes hit disk.

### Why This Matters for Offers

The taker's `accept` command constructs changes for **multiple objects**:
- Their bucket (spending payment coins)
- The offer object (pay + settle blocks)

Without batch atomicity, a taker could spend their coins but the settle could fail, leaving them with nothing. With `pushChangesBatch`, either both succeed or neither is written.

## Validator Rules

### `validateOfferChange`

- **Genesis**: Must have `maker_pubkey` and `terms`. Must be first change.
- **Escrow**: Only when status is `open`. Amount must be positive uint. No duplicate `coin_id`.
- **Pay**: Only when status is `open` or `funded`. No duplicate `coin_id`.
- **Settle**: Only when status is `open` or `funded` (payments may be in the same batch). Outputs must be non-empty valid JSON array.
- **Cancel**: Only when status is `open` or `funded`.
- **Spend** (output claim): Coin must exist in `outputs` map and not already be spent.
- **Double state op**: Only one of escrow/pay/settle/cancel per change.

### Same-Batch Settlement

In V1, `offer_settle` is allowed when status is `open` because the `offer_pay` blocks may be in the **same batch** and haven't been replayed into state yet. The settlement outputs are constructed from `terms.requested` and `terms.offered` directly, not from replay state.

## Security Properties

| Property | Mechanism |
|----------|-----------|
| **No theft** | Taker cannot take escrow without paying. Settlement outputs are fixed at accept time. |
| **No free option** | Maker can cancel anytime before settlement, reclaiming escrow. |
| **No replay** | Nonce monotonicity in `/consensus` + content-addressed changes. |
| **No partial execution** | `pushChangesBatch` guarantees all-or-nothing. |
| **No expiry griefing** | Offers never expire (Grant's choice). |

## Multi-Asset from Day One

Both `offered` and `requested` are arrays:

```json
{
  "offered": [
    {"tokenId": "tokenA", "amount": "1000"},
    {"tokenId": "tokenC", "amount": "200"}
  ],
  "requested": [
    {"tokenId": "tokenB", "amount": "500"}
  ]
}
```

The taker must provide sufficient balance for **all** requested tokens. The settlement creates one output per entry in both arrays.

## Files

| File | Role |
|------|------|
| `src/programs/handlers/coin.ts` | Offer ops, replay, validator, CLI commands |
| `src/index.ts` | `pushChangesBatch` kernel API, fresh `store.get` from disk |
| `src/programs/runtime.ts` | `BatchValidationContext` type |
| `test/chain/coin-offer.test.ts` | 11 tests: replay, validation, edge cases |

## Future Work

- **V2 batch context**: Cross-check `allChanges` in validator to enforce payment amounts match `terms.requested` without relying on the "open settle" escape hatch.
- **Maker-settle**: Allow maker to settle after taker pays (currently taker settles atomically).
- **Partial fills**: Allow taking a subset of requested tokens.
- **Offer chaining**: Use settled offer outputs as inputs to another offer.

---

*Built on glon's DAG kernel with cross-object batch validation (`pushChangesBatch`).*
*Inspired by Chia's partial spend bundles, adapted for single-object Changes and stateless validators.*


Last updated: 2026-05-05

MIT