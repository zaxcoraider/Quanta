// Standalone runner for the research engine — no CROO keys required.
// Proves the deliverable is real before you ever touch the marketplace, and is
// handy for recording the "what the buyer gets" part of the demo video.
//
// Usage:  npm run research -- <chain> <tokenAddressOrSymbol> [--md]
//   e.g.  npm run research -- base 0x4200000000000000000000000000000000000006
//         npm run research -- ethereum PEPE
//         npm run research -- solana BONK --md      (human-readable brief)

import { runResearch, validateInput } from "./engine";
import { renderMarkdown } from "./engine/report";

async function main() {
  const args = process.argv.slice(2);
  const asMarkdown = args.includes("--md") || args.includes("--markdown");
  const [chain, token] = args.filter((a) => !a.startsWith("--"));
  if (!chain || !token) {
    console.error("Usage: npm run research -- <chain> <tokenAddressOrSymbol> [--md]");
    process.exitCode = 1;
    return;
  }

  const input = validateInput({ chain, token });
  const report = await runResearch(input);
  console.log(asMarkdown ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("Error:", e.message);
  // exitCode (not process.exit) lets pending handles drain — avoids a libuv
  // assertion on Windows under ts-node.
  process.exitCode = 1;
});
