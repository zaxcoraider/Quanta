// Live buyer->Zodyl->Quanta demo using only the TWO existing agents (no 3rd).
//
// CAP allows only ONE websocket per SDK key, so you cannot run a standalone
// Quanta provider AND a separate Quanta-keyed buyer at the same time (the second
// connection is kicked as a "duplicate key"). The fix: ONE process, ONE
// connection using Quanta's key that plays BOTH roles at once —
//   (a) the Quanta due-diligence PROVIDER (fulfilling Zodyl's per-token hires), and
//   (b) the BUYER of Zodyl's portfolio service.
// All of Quanta's events (as provider AND as requester) arrive on that single
// connection; the handlers just filter by which order is which. Zodyl runs
// separately with its own key (`npm run zodyl`). Two keys, two connections.
//
// Usage:  npm run demo:portfolio:self -- base 0xTokenA,0xTokenB
//   (run `npm run zodyl` in another terminal first)

import { EventType, type Event } from "@croo-network/sdk";
import { providerClient, SERVICE_ID, ZODYL_SERVICE_ID, loadRegistry } from "./config";
import { handleNegotiation as quantaHandleNegotiation, handlePaid as quantaHandlePaid } from "./provider";

const TIMEOUT_MS = Number(process.env.DEMO_TIMEOUT_MS || 300_000);

async function main() {
  const chain = process.argv[2] || "base";
  const tokensArg = process.argv[3];
  if (!tokensArg) {
    console.error("Usage: npm run demo:portfolio:self -- <chain> <comma,separated,tokens>");
    process.exitCode = 1;
    return;
  }
  if (!ZODYL_SERVICE_ID) throw new Error("Set CROO_ZODYL_SERVICE_ID to Zodyl's portfolio service id.");
  if (!SERVICE_ID) throw new Error("Set CROO_SERVICE_ID to Quanta's due-diligence service id.");

  const tokens = tokensArg.split(/[\s,]+/).filter(Boolean);
  const client = providerClient(); // Quanta's key — the single shared connection.
  const registry = loadRegistry();
  const requirements = JSON.stringify({ chain, tokens });

  const stream = await client.connectWebSocket();

  // --- Quanta-as-PROVIDER role: fulfill due-diligence orders Zodyl places. ---
  // These handlers filter on SERVICE_ID (Quanta's own service), so they ignore
  // the portfolio order (Zodyl's service) that this same process is buying.
  stream.on(EventType.NegotiationCreated, (ev) => void quantaHandleNegotiation(client, ev));
  stream.on(EventType.OrderPaid, (ev) => void quantaHandlePaid(client, stream, registry, ev));

  const finish = (code: number) => {
    stream.close();
    process.exit(code);
  };
  const timer = setTimeout(() => {
    console.error(`⏱️  Timed out after ${TIMEOUT_MS / 1000}s. Is 'npm run zodyl' running and funded?`);
    finish(1);
  }, TIMEOUT_MS);
  timer.unref?.();

  // --- Quanta-as-BUYER role: hire Zodyl's portfolio service. Tracked by the
  // portfolio order's own ids so it never collides with the provider role. ---
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
    if (evNegotiationId !== negotiationId) return; // not the portfolio order
    orderId = ev.order_id;
    console.log(`💳 Portfolio order ${orderId} created. Paying Zodyl into escrow...`);
    try {
      const res = await client.payOrder(orderId);
      console.log(`   Paid. txHash=${res.txHash}`);
    } catch (e: any) {
      console.error(`   Payment failed: ${e.message}`);
      finish(1);
    }
  });

  stream.on(EventType.OrderCompleted, async (ev) => {
    if (!isOurs(ev) || !ev.order_id) return; // only the portfolio order
    try {
      const delivery = await client.getDelivery(ev.order_id);
      console.log(`\n✅ Portfolio delivered. Content hash (on-chain proof): ${delivery.contentHash}`);
      try {
        console.log("\n=== PORTFOLIO RISK SCAN (Zodyl, composed from Quanta) ===");
        console.log(JSON.stringify(JSON.parse(delivery.deliverableSchema), null, 2));
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
    console.error(`❌ Portfolio order ${ev.order_id} rejected: ${ev.reason || "(no reason)"}`);
    finish(1);
  });
  stream.on(EventType.OrderExpired, (ev) => {
    if (!isOurs(ev)) return;
    console.error(`⌛ Portfolio order ${ev.order_id} expired.`);
    finish(1);
  });

  console.log("🟢 Quanta online as BOTH due-diligence provider and portfolio buyer (single key).");
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
