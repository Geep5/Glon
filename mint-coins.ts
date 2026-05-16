import { createClient } from "rivetkit/client";
import type { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";
import { randomUUID } from "node:crypto";
import { hexDecode } from "./src/crypto.js";
import { encodeChange } from "./src/proto.js";
import {
  buildBucketGenesisChange,
  buildCoinOpChange,
} from "./src/programs/handlers/coin.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);

async function main() {
  const walletPath = `${process.env.HOME}/.glon/wallet.json`;
  const { __test: walletTest } = await import("./src/programs/handlers/wallet.js");
  const keys = walletTest.doList(walletPath);
  const defaultKey = keys.find((k: any) => k.name === "default");
  
  if (!defaultKey) {
    console.log("No default key found");
    return;
  }
  
  console.log("Using key:", defaultKey.pubkey.slice(0, 24) + "...");
  
  // Use known token ID
  const tokenId = "d2b1feb2bc774ff7a1f8aa17";
  console.log("Token:", tokenId);
  
  // Create bucket
  const bucketId = randomUUID().replace(/-/g, "").slice(0, 16);
  console.log("Creating bucket:", bucketId);
  
  const genesisChange = buildBucketGenesisChange({
    bucketId,
    timestamp: Date.now(),
    author: "mint-script",
    tokenId,
    capacity: 1000,
  });
  
  const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
  const { changeB64: signedGenesisB64 } = walletTest.doSignChange({
    name: "default",
    changeB64: genesisB64,
    nonce: Date.now(),
    fee: 100,
  }, walletPath);
  
  const bucketActor = client.objectActor.getOrCreate([bucketId], { createWithInput: { id: bucketId } });
  await bucketActor.pushChanges(signedGenesisB64);
  console.log("Bucket created:", bucketId);
  
  // Mint
  const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
  const headId = await bucketActor.getHeads().then((h: any) => h[0]);
  
  const mintChange = buildCoinOpChange({
    bucketId,
    parentIds: [hexDecode(headId)],
    timestamp: Date.now(),
    author: "mint-script",
    op: { kind: "create", coinId, ownerPubkey: defaultKey.pubkey, amount: "10000" },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  
  const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
  const { changeB64: signedMintB64 } = walletTest.doSignChange({
    name: "default",
    changeB64: mintB64,
    nonce: Date.now() + 1,
    fee: 10,
  }, walletPath);
  
  await bucketActor.pushChanges(signedMintB64);
  console.log("Minted 10000 coins:", coinId);
  
  // Check balance via store
  const store = client.storeActor.getOrCreate(["root"]);
  const bal = await store.coinBalance(tokenId, defaultKey.pubkey);
  console.log("Balance:", bal);
}

main().catch(console.error);
