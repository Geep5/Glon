import { app } from './src/index';
import { createClient } from 'rivetkit';

async function main() {
  const client = createClient({});
  const c = client.getOrCreate(app);
  
  // Query coins table
  const coins = await c.db.execute("SELECT token_id, owner_pubkey, amount, spent FROM coins WHERE spent = 0");
  console.log(`Found ${coins.length} unspent coins`);
  
  // Group by token and owner
  const balances = new Map();
  for (const coin of coins) {
    const key = `${coin.token_id}:${coin.owner_pubkey}`;
    const current = balances.get(key) || { token: coin.token_id, owner: coin.owner_pubkey, amount: 0n };
    current.amount += BigInt(coin.amount);
    balances.set(key, current);
  }
  
  // Print
  for (const [key, bal] of balances) {
    console.log(`${bal.token} | ${bal.owner.slice(0,16)}... | ${bal.amount.toString()}`);
  }
}

main().catch(console.error);
