import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";
import { randomUUID } from "node:crypto";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);

async function main() {
  const store = client.storeActor.getOrCreate(["root"]);
  const walletActor = client.walletActor.getOrCreate(["default"]);
  
  // Get default key
  const keys = await walletActor.list();
  const defaultKey = keys.find((k: any) => k.name === "default");
  if (!defaultKey) {
    console.log("No default key found");
    return;
  }
  console.log("Using key:", defaultKey.pubkey.slice(0, 20) + "...");
  
  // Get token
  const token = await store.get("d2b1feb2bc774ff7a1f8aa17");
  const ownerPubkey = token?.fields?.owner_pubkey?.stringValue;
  console.log("Token owner:", ownerPubkey?.slice(0, 20) + "...");
  console.log("Key matches owner:", defaultKey.pubkey === ownerPubkey);
  
  if (defaultKey.pubkey !== ownerPubkey) {
    console.log("Default key is not the token owner — cannot mint");
    return;
  }
  
  // Get bucket
  const bucketId = "49a1278f22874b9691bad8ae";
  const bucket = await store.get(bucketId);
  console.log("Bucket blocks:", bucket?.blockCount || 0);
  
  // Import coin handler functions
  const { buildBucketGenesisChange, buildCoinOpChange } = await import("./src/programs/handlers/coin.js");
  const { encodeChange } = await import("./src/proto.js");
  const { hexDecode } = await import("./src/crypto.js");
  
  // Build genesis change if bucket has no blocks
  let parentIds: Uint8Array[] = [];
  if ((bucket?.blockCount || 0) === 0) {
    console.log("Creating bucket genesis...");
    const genesisChange = buildBucketGenesisChange({
      bucketId,
      timestamp: Date.now(),
      author: "mint-test",
      tokenId: "d2b1feb2bc774ff7a1f8aa17",
    });
    const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
    
    // Sign with wallet
    const signedGenesis = await walletActor.signChange({
      name: "default",
      changeB64: genesisB64,
      nonce: 1,
      fee: 10,
    });
    
    // Push to bucket
    const bucketActor = client.objectActor.getOrCreate([bucketId], { createWithInput: { id: bucketId } });
    await bucketActor.pushChanges(signedGenesis.changeB64);
    console.log("Genesis pushed");
    
    const heads = await bucketActor.getHeadIds();
    parentIds = heads.map(hexDecode);
  } else {
    const bucketActor = client.objectActor.getOrCreate([bucketId]);
    const heads = await bucketActor.getHeadIds();
    parentIds = heads.map(hexDecode);
  }
  
  // Mint coin
  console.log("Minting coin...");
  const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
  const mintChange = buildCoinOpChange({
    bucketId,
    parentIds,
    timestamp: Date.now(),
    author: "mint-test",
    op: { kind: "create", coinId, ownerPubkey: defaultKey.pubkey, amount: "1000000" },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
  
  const signedMint = await walletActor.signChange({
    name: "default",
    changeB64: mintB64,
    nonce: 2,
    fee: 10,
  });
  
  const bucketActor = client.objectActor.getOrCreate([bucketId]);
  await bucketActor.pushChanges(signedMint.changeB64);
  console.log("Minted 1000000 TC to", defaultKey.pubkey.slice(0, 20) + "...");
  
  // Check balance
  const balance = await (store as any).coinBalance("d2b1feb2bc774ff7a1f8aa17", defaultKey.pubkey);
  console.log("Balance:", balance);
}

main().catch(console.error);
