import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";
import { randomUUID } from "node:crypto";
import { hexDecode } from "./src/crypto.js";
import { encodeChange } from "./src/proto.js";
import {
  buildBucketGenesisChange,
  buildCoinOpChange,
} from "./src/programs/handlers/coin.js";

const client = createClient<typeof app>(resolveEndpoint());

async function mintToken(name: string, symbol: string, amount: string) {
  const walletPath = `${process.env.HOME}/.glon/wallet.json`;
  const { __test: walletTest } = await import("./src/programs/handlers/wallet.js");
  const keys = walletTest.doList(walletPath);
  const defaultKey = keys.find((k: any) => k.name === "default");
  if (!defaultKey) return;

  const store = client.storeActor.getOrCreate(["root"]);
  
  const tokenId = await store.create("chain.token", JSON.stringify({
    name: { stringValue: name },
    symbol: { stringValue: symbol },
    decimals: { intValue: 6 },
    totalSupply: { stringValue: amount },
    mintRenounced: { boolValue: false },
    ownerPubkey: { stringValue: defaultKey.pubkey },
  }));

  const bucketId = randomUUID().replace(/-/g, "").slice(0, 16);
  const genesisChange = buildBucketGenesisChange({
    bucketId, timestamp: Date.now(), author: "mint-script",
    tokenId, capacity: 1000,
  });
  const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
  const { changeB64: signedGenesisB64 } = walletTest.doSignChange({
    name: "default", changeB64: genesisB64, nonce: Date.now(), fee: 100,
  }, walletPath);

  const bucketActor = client.objectActor.getOrCreate([bucketId], { createWithInput: { id: bucketId } });
  await bucketActor.pushChanges(signedGenesisB64);

  const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
  const headId = await bucketActor.getHeads().then((h: any) => h[0]);
  
  const mintChange = buildCoinOpChange({
    bucketId,
    parentIds: [hexDecode(headId)],
    timestamp: Date.now(),
    author: "mint-script",
    op: { kind: "create", coinId, ownerPubkey: defaultKey.pubkey, amount },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  
  const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
  const { changeB64: signedMintB64 } = walletTest.doSignChange({
    name: "default", changeB64: mintB64, nonce: Date.now() + 1, fee: 10,
  }, walletPath);
  
  await bucketActor.pushChanges(signedMintB64);
  console.log(`Minted ${amount} ${symbol} — token: ${tokenId}, bucket: ${bucketId}`);
}

async function main() {
  await mintToken("GrantCoin", "GRANT", "10000000");
  await mintToken("TestUSD", "TUSD", "1000000");
  await mintToken("NounsToken", "NOUN", "500000");
  
  const store = client.storeActor.getOrCreate(["root"]);
  const tokens = await store.list("chain.token");
  console.log(`\nTotal tokens: ${tokens.length}`);
  
  for (const t of tokens) {
    const obj = await store.get(t.id);
    const name = obj?.fields?.name?.stringValue || "?";
    const symbol = obj?.fields?.symbol?.stringValue || "?";
    const holders = await (store as any).coinHolders(t.id);
    console.log(`${name} (${symbol}): ${holders.length} holder(s)`);
    for (const h of holders) {
      console.log(`  ${h.pubkey.slice(0, 16)}...: ${h.balance}`);
    }
  }
}

main().catch(console.error);
