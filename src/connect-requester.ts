// One-off: bring the REQUESTER agent (Zodyl) online.
//
// A freshly-registered CROO agent stays in DRAFT until its SDK connects a
// websocket at least once — the same step that took the provider (Quanta)
// from DRAFT to OFFLINE. Until then its AA wallet is "not in a deployable
// state" and cannot receive a transfer. This script just connects Zodyl and
// holds the session open so the platform records it as live, then you can fund
// it and run `npm run demo`.
//
// Usage:  npm run connect:requester      (Ctrl-C to stop once it shows online)

import { requesterClient } from "./config";

async function main() {
  const client = requesterClient();
  console.log("🔌 Connecting Zodyl (requester) to CROO...");
  const stream = await client.connectWebSocket();
  console.log("🟢 Zodyl online. The agent should now leave DRAFT and become fundable.");
  console.log("   Keep this running, fund it in the dashboard, then Ctrl-C.");

  const shutdown = () => {
    console.log("\n👋 Closing Zodyl session.");
    stream.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
