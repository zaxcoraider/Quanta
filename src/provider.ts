// CROO CAP provider loop for the Token Due-Diligence agent.
//
// Lifecycle (verified against @croo-network/sdk v0.2.1):
//   1. connectWebSocket() and subscribe to events.
//   2. order_negotiation_created  -> inspect requirements, acceptNegotiation()
//      (backend then submits createOrder on-chain).
//   3. order_paid                 -> escrow is locked in CAPVault; run the
//      research and deliverOrder() with a `schema` deliverable. A keccak256 of
//      the deliverable is written on-chain; verification passes -> USDC settles
//      to our AA wallet automatically.
//
// We only do paid work AFTER order_paid, so nobody can extract a free report.
//
// A2A: if CROO_UPSTREAM_SERVICE_ID is set, fulfilling an order also HIRES
// another CAP agent (paid from this agent's wallet) and attaches its
// deliverable + on-chain contentHash as a cited annex — provider and requester
// in the same transaction.

import { EventType, type AgentClient, type Event } from "@croo-network/sdk";
import { providerClient, UPSTREAM_SERVICE_ID, UPSTREAM_TIMEOUT_MS } from "./config";
import { runResearch, validateInput } from "./engine";
import { hireUpstream } from "./upstream";

type Stream = Awaited<ReturnType<AgentClient["connectWebSocket"]>>;

// Idempotency guards: the event stream reconnects and the backend may
// redeliver events; accepting or delivering the same order twice would be a
// payment-state bug, so every handler is keyed on first-seen IDs.
const seenNegotiations = new Set<string>();
const seenPaidOrders = new Set<string>();

async function handleNegotiation(client: AgentClient, ev: Event) {
  const negotiationId = ev.negotiation_id;
  if (!negotiationId || seenNegotiations.has(negotiationId)) return;
  seenNegotiations.add(negotiationId);

  try {
    const negotiation = await client.getNegotiation(negotiationId);

    // Events for negotiations where WE are the requester (our upstream A2A
    // hires) arrive on this same stream — never try to "accept" our own hire.
    if (UPSTREAM_SERVICE_ID && negotiation.serviceId === UPSTREAM_SERVICE_ID) return;

    // Validate the requester's requirements up front. If they're malformed we
    // reject with a helpful reason instead of accepting an unfulfillable order.
    let parsed: unknown;
    try {
      parsed = JSON.parse(negotiation.requirements || "{}");
      validateInput(parsed);
    } catch (e: any) {
      console.log(`↩︎  Rejecting ${negotiationId}: ${e.message}`);
      await client.rejectNegotiation(negotiationId, `Bad requirements: ${e.message}`);
      return;
    }

    const { order } = await client.acceptNegotiation(negotiationId);
    console.log(`✅ Accepted negotiation ${negotiationId} -> order ${order.orderId} (awaiting payment)`);
  } catch (e: any) {
    console.error(`⚠️  Failed to handle negotiation ${negotiationId}: ${e.message}`);
  }
}

async function handlePaid(client: AgentClient, stream: Stream, ev: Event) {
  const orderId = ev.order_id;
  if (!orderId || seenPaidOrders.has(orderId)) return;
  seenPaidOrders.add(orderId);

  try {
    const order = await client.getOrder(orderId);

    // Same-stream guard: order_paid also fires for upstream orders we are
    // PAYING as a requester — those are not ours to fulfill.
    if (UPSTREAM_SERVICE_ID && order.serviceId === UPSTREAM_SERVICE_ID) return;

    const negotiation = await client.getNegotiation(order.negotiationId);
    const input = validateInput(JSON.parse(negotiation.requirements || "{}"));

    console.log(`🔎 Order ${orderId} paid. Researching ${input.token} on ${input.chain}...`);
    const report = await runResearch(input);

    // Optional A2A hop: hire an upstream CAP agent for an enrichment annex.
    // Bounded and best-effort — never blocks or fails our own delivery.
    if (UPSTREAM_SERVICE_ID) {
      console.log(`🔗 Hiring upstream CAP service ${UPSTREAM_SERVICE_ID} for enrichment...`);
      const annex = await hireUpstream(
        client,
        stream,
        UPSTREAM_SERVICE_ID,
        negotiation.requirements,
        UPSTREAM_TIMEOUT_MS
      );
      if (annex) {
        report.upstream = annex;
        report.sources.push(annex.source);
      }
    }

    await client.deliverOrder(orderId, {
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(report),
    });

    console.log(
      `📦 Delivered order ${orderId}: risk=${report.riskLevel} (${report.riskScore}/100), ` +
        `${report.sources.length} source(s)${report.upstream ? " incl. A2A upstream annex" : ""}. ` +
        `Settlement will clear on verification.`
    );
  } catch (e: any) {
    console.error(`❌ Delivery failed for order ${orderId}: ${e.message}`);
    // Surface a machine-readable failure so the SLA/refund path is honest.
    try {
      await client.rejectOrder(orderId, `Provider error: ${e.message}`.slice(0, 200));
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  const client = providerClient();
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, (ev) => void handleNegotiation(client, ev));
  stream.on(EventType.OrderPaid, (ev) => void handlePaid(client, stream, ev));

  stream.on(EventType.OrderCompleted, (ev) =>
    console.log(`🎉 Order ${ev.order_id} completed — USDC settled to provider wallet.`)
  );
  stream.on(EventType.OrderExpired, (ev) =>
    console.warn(`⌛ Order ${ev.order_id} expired (SLA missed / unpaid).`)
  );

  console.log("🟢 croo-intel-agent provider online. Listening for orders on CAP...");
  if (UPSTREAM_SERVICE_ID) {
    console.log(`🔗 A2A upstream enrichment enabled: ${UPSTREAM_SERVICE_ID}`);
  }

  // Keep the process alive; EventStream auto-reconnects internally.
  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down provider.");
    stream.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
