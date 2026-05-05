import { describe, it } from "node:test";
import assert from "node:assert";
import {
  replayOffer,
  validateOfferChange,
  buildOfferGenesisChange,
  buildCoinOpChange,
  type OfferTerms,
} from "../../src/programs/handlers/coin.js";

describe("coin offer", () => {
  const makerPubkey = "0".repeat(64);
  const takerPubkey = "1".repeat(64);
  const tokenId = "abc123";

  const offerTerms: OfferTerms = {
    offered: [{ tokenId, amount: "100" }],
    requested: [{ tokenId, amount: "50" }],
  };

  function getBlock(change: any) {
    return change.ops?.[0]?.blockAdd?.block;
  }

  it("replays open offer with escrow", () => {
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const state = replayOffer([getBlock(escrow)]);
    assert.strictEqual(state.status, "open");
    assert.strictEqual(state.escrowed.size, 1);
    assert.strictEqual(state.escrowed.get("e1")?.amount, "100");
    assert.strictEqual(state.payments.size, 0);
  });

  it("replays funded offer after payment", () => {
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const payment = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "offer_pay", coinId: "p1", ownerPubkey: takerPubkey, amount: "50", tokenId },
      blockId: "b2",
    });
    const state = replayOffer([getBlock(escrow), getBlock(payment)]);
    assert.strictEqual(state.status, "funded");
    assert.strictEqual(state.payments.size, 1);
    assert.strictEqual(state.payments.get("p1")?.amount, "50");
  });

  it("replays settled offer with outputs", () => {
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const payment = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "offer_pay", coinId: "p1", ownerPubkey: takerPubkey, amount: "50", tokenId },
      blockId: "b2",
    });
    const settle = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 3,
      author: "a",
      op: {
        kind: "offer_settle",
        coinId: "s1",
        outputs: JSON.stringify([
          { coin_id: "o_maker", owner_pubkey: makerPubkey, amount: "50", token_id: tokenId },
          { coin_id: "o_taker", owner_pubkey: takerPubkey, amount: "100", token_id: tokenId },
        ]),
      },
      blockId: "b3",
    });
    const state = replayOffer([getBlock(escrow), getBlock(payment), getBlock(settle)]);
    assert.strictEqual(state.status, "settled");
    assert.strictEqual(state.escrowed.get("e1")?.spent, true);
    assert.strictEqual(state.payments.get("p1")?.spent, true);
    assert.strictEqual(state.outputs.size, 2);
    assert.strictEqual(state.outputs.get("o_maker")?.amount, "50");
    assert.strictEqual(state.outputs.get("o_taker")?.amount, "100");
  });

  it("validates offer genesis", () => {
    const genesis = buildOfferGenesisChange({
      offerId: "o1",
      timestamp: 1,
      author: "a",
      makerPubkey,
      terms: JSON.stringify(offerTerms),
    });
    const result = validateOfferChange(genesis, []);
    assert.strictEqual(result.valid, true);
  });

  it("validates escrow on open offer", () => {
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const result = validateOfferChange(escrow, []);
    assert.strictEqual(result.valid, true);
  });

  it("validates settle on open offer (same-batch payments)", () => {
    const settle = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: {
        kind: "offer_settle",
        coinId: "s1",
        outputs: JSON.stringify([
          { coin_id: "o_maker", owner_pubkey: makerPubkey, amount: "50", token_id: tokenId },
        ]),
      },
      blockId: "b2",
    });
    const result = validateOfferChange(settle, []);
    assert.strictEqual(result.valid, true);
  });

  it("rejects settle with missing outputs", () => {
    const settle = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_settle", coinId: "s1" },
      blockId: "b2",
    });
    const result = validateOfferChange(settle, []);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("missing outputs"));
  });

  it("rejects duplicate escrow coin", () => {
    const escrow1 = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const escrow2 = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b2",
    });
    const result = validateOfferChange(escrow2, [getBlock(escrow1)]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("duplicate escrow"));
  });

  it("rejects spend of unknown output coin", () => {
    const spend = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "spend", coinId: "unknown" },
      blockId: "b1",
    });
    const result = validateOfferChange(spend, []);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("unknown output coin"));
  });

  it("rejects cancelled offer ops", () => {
    const cancel = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_cancel", coinId: "c1" },
      blockId: "b1",
    });
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b2",
    });
    const result = validateOfferChange(escrow, [getBlock(cancel)]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("only when open"));
  });

  it("rejects settle on already-settled offer", () => {
    const escrow = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 1,
      author: "a",
      op: { kind: "offer_escrow", coinId: "e1", ownerPubkey: makerPubkey, amount: "100", tokenId },
      blockId: "b1",
    });
    const payment = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "offer_pay", coinId: "p1", ownerPubkey: takerPubkey, amount: "50", tokenId },
      blockId: "b2",
    });
    const settle = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 3,
      author: "a",
      op: {
        kind: "offer_settle",
        coinId: "s1",
        outputs: JSON.stringify([
          { coin_id: "o_maker", owner_pubkey: makerPubkey, amount: "50", token_id: tokenId },
        ]),
      },
      blockId: "b3",
    });
    const settle2 = buildCoinOpChange({
      bucketId: "o1",
      parentIds: [],
      timestamp: 4,
      author: "a",
      op: {
        kind: "offer_settle",
        coinId: "s2",
        outputs: JSON.stringify([
          { coin_id: "o2", owner_pubkey: makerPubkey, amount: "50", token_id: tokenId },
        ]),
      },
      blockId: "b4",
    });
    const result = validateOfferChange(settle2, [getBlock(escrow), getBlock(payment), getBlock(settle)]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("only when open or funded"));
  });
});
