import { createClient } from "rivetkit/client";
import { app } from "./src/index.js";
import { resolveEndpoint } from "./src/endpoint.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);

async function main() {
  const store = client.storeActor.getOrCreate(["root"]);
  
  // Read wallet directly
  const wallet = JSON.parse(readFileSync(process.env.HOME + "/.glon/wallet.json", "utf-8"));
  const defaultKey = wallet.keys.default;
  
  // Import functions
  const { buildBucketGenesisChange, buildCoinOpChange } = await import("./src/programs/handlers/coin.js");
  const { encodeChange } = await import("./src/proto.js");
  const { hexDecode } = await import("./src/crypto.js");
  const { sign } = await import("./src/det/ed25519.js");
  const { sha256 } = await import("./src/crypto.js");
  
  const bucketId = "49a1278f22874b9691bad8ae";
  
  // Build and sign genesis change
  console.log("Creating bucket genesis...");
  const genesisChange = buildBucketGenesisChange({
    bucketId,
    timestamp: Date.now(),
    author: "mint-test",
    tokenId: "d2b1feb2bc774ff7a1f8aa17",
  });
  
  // Sign manually
  const signingBytes = encodeChange({ ...genesisChange, id: new Uint8Array(32) });
  const signature = sign(hexDecode(defaultKey.privateKey), signingBytes);
  genesisChange.authorSig = {
    pubkey: hexDecode(defaultKey.pubkey),
    signature,
    nonce: 1,
    fee: 10,
  };
  genesisChange.id = sha256(encodeChange(genesisChange));
  
  const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
  
  // Push to bucket - try without createWithInput
  const bucketActor = client.objectActor.getOrCreate([bucketId]);
  try {
    await bucketActor.pushChanges(genesisB64);
    console.log("Genesis pushed successfully");
  } catch (e: any) {
    console.log("Genesis push error:", e?.message || e);
    return;
  }
  
  const heads = await bucketActor.getHeadIds();
  const parentIds = heads.map((h: string) => hexDecode(h));
  
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
  
  // Sign manually
  const mintSigningBytes = encodeChange({ ...mintChange, id: new Uint8Array(32) });
  const mintSignature = sign(hexDecode(defaultKey.privateKey), mintSigningBytes);
  mintChange.authorSig = {
    pubkey: hexDecode(defaultKey.pubkey),
    signature: mintSignature,
    nonce: 2,
    fee: 10,
  };
  mintChange.id = sha256(encodeChange(mintChange));
  
  const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
  
  try {
    await bucketActor.pushChanges(mintB64);
    console.log("Mint pushed successfully");
  } catch (e: any) {
    console.log("Mint push error:", e?.message || e);
    return;
  }
  
  // Check balance
  const balance = await (store as any).coinBalance("d2b1feb2bc774ff7a1f8aa17", defaultKey.pubkey);
  console.log("Balance:", balance);
}

main().catch(console.error);
