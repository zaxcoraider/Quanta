// A2A ecosystem demo: a buyer hires ZODYL's portfolio-scan service with a
// watchlist. Zodyl then hires QUANTA per token (routed through the registry) and
// returns one aggregated, verifiable portfolio verdict:
//
//     buyer → Zodyl (portfolio) → Quanta (due-diligence ×N) → data sources
//
// Prereqs:
//   - Quanta provider running   (`npm run provider`)
//   - Zodyl  provider running    (`npm run zodyl`)
//   - CROO_ZODYL_SERVICE_ID set to Zodyl's portfolio service id
//   - CROO_BUYER_SDK_KEY (or CROO_SDK_KEY) = a funded agent that is NOT Zodyl
//
// Usage:  npm run demo:portfolio -- base WETH,USDC,0x4200...0006

import { EventType, type Event } from "@croo-network/sdk";
import { buyerClient, ZODYL_SERVICE_ID } from "./config";

const TIMEOUT_MS = Number(process.env.DEMO_TIMEOUT_MS || 300_000);

async function main() {
  const chain = process.argv[2] || "base";
  const tokensArg = process.argv[3];
  if (!tokensArg) {
    console.error("Usage: npm run demo:portfolio -- <chain> <comma,separated,tokens>");
    process.exitCode = 1;
    return;
  }
  if (!ZODYL_SERVICE_ID) throw new Error("Set CROO_ZODYL_SERVICE_ID to Zodyl's portfolio service id.");

  const tokens = tokensArg.split(/[\s,]+/).filter(Boolean);
  const client = buyerClient();
  const requirements = JSON.stringify({ chain, tokens });

  const stream = await client.connectWebSocket();
  const finish = (code: number) => {
    stream.close();
    process.exit(code);
  };
  const timer = setTimeout(() => {
    console.error(
      `⏱️  Timed out after ${TIMEOUT_MS / 1000}s. Check that BOTH providers are running, ` +
        `the Zodyl service id is correct, and both agents' wallets hold USDC on Base.`
    );
    finish(1);
  }, TIMEOUT_MS);
  timer.unref?.();

  let negotiationId = "";
  let orderId = "";
  let negotiationReady!: () => void;
  const negotiationKnown = new Promise<void>((r) => (negotiationReady = r));
  const isOurs = (ev: Event) =>
    (ev.negotiation_id && ev.negotiation_id === negotiationId) ||
    (ev.order_id && ev.order_id === orderId);

  stream.on(EventType.NegotiationRejected, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`❌ Zodyl rejected the negotiation: ${ev.reason || "(no reason)"}`);
    finish(1);
  });
  stream.on(EventType.NegotiationExpired, (ev) => {
    if (!isOurs(ev)) return;
    console.error("⌛ Negotiation expired before Zodyl accepted.");
    finish(1);
  });

  stream.on(EventType.OrderCreated, async (ev) => {
    if (!ev.order_id || orderId) return;
    await negotiationKnown;
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
        console.log("\n=== PORTFOLIO RISK SCAN (Zodyl, composed from Quanta) ===");
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
    console.error(`❌ Order ${ev.order_id} rejected: ${ev.reason || "(no reason)"}`);
    finish(1);
  });
  stream.on(EventType.OrderExpired, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`⌛ Order ${ev.order_id} expired (unpaid or SLA missed).`);
    finish(1);
  });

  console.log(`🤝 Hiring Zodyl portfolio scan: [${tokens.join(", ")}] on ${chain} (service ${ZODYL_SERVICE_ID})`);
  const negotiation = await client.negotiateOrder({ serviceId: ZODYL_SERVICE_ID, requirements });
  negotiationId = negotiation.negotiationId;
  negotiationReady();
  console.log(`📝 Negotiation ${negotiationId} created. Waiting for Zodyl to accept...`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
