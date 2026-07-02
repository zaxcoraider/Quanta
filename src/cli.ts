// Standalone runner for the research engine — no CROO keys required.
// Proves the deliverable is real before you ever touch the marketplace, and is
// handy for recording the "what the buyer gets" part of the demo video.
//
// Usage:  npm run research -- <chain> <tokenAddressOrSymbol>
//   e.g.  npm run research -- base 0x4200000000000000000000000000000000000006
//         npm run research -- ethereum PEPE

import { runResearch, validateInput } from "./engine";

async function main() {
  const chain = process.argv[2];
  const token = process.argv[3];
  if (!chain || !token) {
    console.error("Usage: npm run research -- <chain> <tokenAddressOrSymbol>");
    process.exitCode = 1;
    return;
  }

  const input = validateInput({ chain, token });
  const report = await runResearch(input);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("Error:", e.message);
  // exitCode (not process.exit) lets pending handles drain — avoids a libuv
  // assertion on Windows under ts-node.
  process.exitCode = 1;
});
