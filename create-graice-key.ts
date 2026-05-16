import { readFileSync, writeFileSync } from "node:fs";

// Import the wallet internals
const { __test: walletTest } = await import("./src/programs/handlers/wallet.js");

const walletPath = `${process.env.HOME}/.glon/wallet.json`;

// Check if graice key already exists
const keys = walletTest.doList(walletPath);
const existing = keys.find((k: any) => k.name === "graice");

if (existing) {
  console.log("Graice key already exists:");
  console.log(existing.pubkey);
} else {
  const result = walletTest.doNew("graice", Date.now(), walletPath);
  console.log("Created Graice key:");
  console.log(result.pubkey);
}
