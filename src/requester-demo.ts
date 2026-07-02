// A2A composability demo: a SECOND CROO agent hires our due-diligence agent,
// pays USDC, and receives the delivered report. This is exactly the flow judges
// run, and it exercises the reward-eligibility signals (unique counterparty
// agent + unique buyer wallet).
//
// Prereqs:
//   - Provider running (`npm run provider`) and its service listed on the store.
//   - CROO_SERVICE_ID set to that service's id.
//   - CROO_REQUESTER_SDK_KEY set, and the requester's AA wallet funded with a
//     little USDC on Base to cover price + fee.
//
// Usage:  npm run demo -- base 0xYourTokenAddress

import { EventType, type Event } from "@croo-network/sdk";
import { requesterClient, SERVICE_ID } from "./config";

// Whole-flow deadline. If negotiation, payment, delivery, or settlement stalls,
// we exit with a clear message instead of hanging silently.
const TIMEOUT_MS = Number(process.env.DEMO_TIMEOUT_MS || 240_000);

async function main() {
  const chain = process.argv[2] || "base";
  const token = process.argv[3];
  if (!token) {
    console.error("Usage: npm run demo -- <chain> <tokenAddressOrSymbol>");
    process.exitCode = 1;
    return;
  }
  if (!SERVICE_ID) throw new Error("Set CROO_SERVICE_ID to the provider's service id.");

  const client = requesterClient();
  const requirements = JSON.stringify({ chain, token });

  // Connect the event stream BEFORE negotiating. If the provider accepts
  // quickly, order_created can fire immediately — negotiating first would race
  // the subscription and the demo would never pay.
  const stream = await client.connectWebSocket();

  const finish = (code: number) => {
    stream.close();
    process.exit(code);
  };

  const timer = setTimeout(() => {
    console.error(
      `⏱️  Timed out after ${TIMEOUT_MS / 1000}s. Check that the provider is running, ` +
        `the service id is correct, and the requester wallet holds enough USDC on Base.`
    );
    finish(1);
  }, TIMEOUT_MS);
  timer.unref?.();

  // Filled in as the flow progresses; used to ignore events from other orders
  // this agent may have in flight.
  let negotiationId = "";
  let orderId = "";

  // negotiateOrder() resolves after events can already be flowing; handlers
  // await this so a fast provider accept can't slip past the ID check.
  let negotiationReady!: () => void;
  const negotiationKnown = new Promise<void>((r) => (negotiationReady = r));

  const isOurs = (ev: Event) =>
    (ev.negotiation_id && ev.negotiation_id === negotiationId) ||
    (ev.order_id && ev.order_id === orderId);

  stream.on(EventType.NegotiationRejected, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`❌ Provider rejected the negotiation: ${ev.reason || "(no reason given)"}`);
    finish(1);
  });

  stream.on(EventType.NegotiationExpired, (ev) => {
    if (!isOurs(ev)) return;
    console.error("⌛ Negotiation expired before the provider accepted.");
    finish(1);
  });

  stream.on(EventType.OrderCreated, async (ev) => {
    if (!ev.order_id || orderId) return;
    await negotiationKnown;
    // The event may omit negotiation_id; fall back to looking the order up.
    let evNegotiationId = ev.negotiation_id;
    if (!evNegotiationId) {
      try {
        evNegotiationId = (await client.getOrder(ev.order_id)).negotiationId;
      } catch {
        return;
      }
    }
    if (evNegotiationId !== negotiationId) return;
    orderId = ev.order_id;
    console.log(`💳 Order ${orderId} created. Paying USDC into escrow...`);
    try {
      const res = await client.payOrder(orderId);
      console.log(`   Paid. txHash=${res.txHash}`);
    } catch (e: any) {
      console.error(`   Payment failed: ${e.message}`);
      finish(1);
    }
  });

  stream.on(EventType.OrderCompleted, async (ev) => {
    if (!isOurs(ev) || !ev.order_id) return;
    try {
      const delivery = await client.getDelivery(ev.order_id);
      console.log(`\n✅ Delivered. Content hash (on-chain proof): ${delivery.contentHash}`);
      try {
        const report = JSON.parse(delivery.deliverableSchema);
        console.log("\n=== TOKEN DUE-DILIGENCE REPORT ===");
        console.log(JSON.stringify(report, null, 2));
      } catch {
        console.log(delivery.deliverableText || delivery.deliverableSchema);
      }
      finish(0);
    } catch (e: any) {
      console.error(`Failed to fetch delivery: ${e.message}`);
      finish(1);
    }
  });

  stream.on(EventType.OrderRejected, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`❌ Order ${ev.order_id} rejected: ${ev.reason || "(no reason given)"}`);
    finish(1);
  });

  stream.on(EventType.OrderExpired, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`⌛ Order ${ev.order_id} expired (unpaid or SLA missed).`);
    finish(1);
  });

  console.log(`🤝 Requesting research: ${token} on ${chain} (service ${SERVICE_ID})`);
  const negotiation = await client.negotiateOrder({ serviceId: SERVICE_ID, requirements });
  negotiationId = negotiation.negotiationId;
  negotiationReady();
  console.log(`📝 Negotiation ${negotiationId} created. Waiting for provider accept...`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
