// Fetch a settled order's CAP Delivery and save it to disk, so the exact
// on-chain-committed bytes (`deliverableSchema`) + `contentHash` can be fed to
// the independent verifier:  npm run verify -- <file>.
//
// Usage:  npm run fetch:delivery -- <orderId> [outFile]

import { writeFileSync } from "node:fs";
import { requesterClient } from "./config";

async function main() {
  const orderId = process.argv[2];
  const out = process.argv[3] || "delivery.json";
  if (!orderId) {
    console.error("Usage: npm run fetch:delivery -- <orderId> [outFile]");
    process.exitCode = 1;
    return;
  }
  const client = requesterClient();
  const delivery = await client.getDelivery(orderId);
  writeFileSync(out, JSON.stringify(delivery, null, 2));
  console.log(`Saved delivery for order ${orderId} -> ${out}`);
  console.log(`contentHash: ${(delivery as any).contentHash}`);
}

main().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
