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
import {
  providerClient,
  SERVICE_ID,
  UPSTREAM_TIMEOUT_MS,
  ENRICH_CAPABILITY,
  loadRegistry,
} from "./config";
import { runResearch, validateInput } from "./engine";
import type { RiskFlag, Source, TokenReport } from "./engine/types";
import { hireForCapability } from "./upstream";
import { route, explainRoute, type AgentServiceEntry } from "./registry";

// The registered CAP service declares `flags` and `sources` as arrays of STRING
// (CAP schema arrays only support primitive item types — string/number/boolean,
// not object). Our internal report carries them as rich objects, so we render
// them to strings at delivery to satisfy the on-chain deliverable schema. This
// is lossless for verification: every citation also lives in a nested
// `Cited.source` object (market/contract/holders/security), which verify.ts's
// collectSources() still walks and re-fetches. Each source's URL is kept inline
// in the string too, so the top-level list stays machine-parseable.
export function renderFlag(f: RiskFlag): string {
  const base = `${f.code} | ${f.level} | ${f.category} | ${f.message}`;
  return f.source ? `${base} | source: ${f.source.url}` : base;
}
export function renderSource(s: Source): string {
  return `${s.provider} | ${s.url} | ${s.fetchedAt}`;
}

/** Project a report onto the CAP deliverable schema (string[] flags/sources). */
export function toDeliverable(report: TokenReport): Record<string, unknown> {
  return {
    ...report,
    flags: report.flags.map(renderFlag),
    sources: report.sources.map(renderSource),
  };
}

type Stream = Awaited<ReturnType<AgentClient["connectWebSocket"]>>;

// Idempotency guards: the event stream reconnects and the backend may
// redeliver events; accepting or delivering the same order twice would be a
// payment-state bug, so every handler is keyed on first-seen IDs.
const seenNegotiations = new Set<string>();
const seenPaidOrders = new Set<string>();

export async function handleNegotiation(client: AgentClient, ev: Event) {
  const negotiationId = ev.negotiation_id;
  if (!negotiationId || seenNegotiations.has(negotiationId)) return;
  seenNegotiations.add(negotiationId);

  try {
    const negotiation = await client.getNegotiation(negotiationId);

    // We only fulfill orders for OUR OWN service. Negotiations for any other
    // service on this stream are the router's own A2A hires (where we are the
    // requester) — never try to "accept" our own hire.
    if (SERVICE_ID && negotiation.serviceId !== SERVICE_ID) return;

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

export async function handlePaid(client: AgentClient, stream: Stream, registry: AgentServiceEntry[], ev: Event) {
  const orderId = ev.order_id;
  if (!orderId || seenPaidOrders.has(orderId)) return;
  seenPaidOrders.add(orderId);

  try {
    const order = await client.getOrder(orderId);

    // Same-stream guard: order_paid also fires for the router's own upstream
    // orders (where we are the requester) — those are not ours to fulfill.
    if (SERVICE_ID && order.serviceId !== SERVICE_ID) return;

    const negotiation = await client.getNegotiation(order.negotiationId);
    const input = validateInput(JSON.parse(negotiation.requirements || "{}"));

    console.log(`🔎 Order ${orderId} paid. Researching ${input.token} on ${input.chain}...`);
    const report = await runResearch(input);

    // Optional A2A hop, routed through the ecosystem registry: hire a specialist
    // for ENRICH_CAPABILITY — internal ecosystem agents first, then the open
    // store — and attach its cited, on-chain-committed deliverable as an annex.
    // Self-excluded (Quanta never hires Quanta) and best-effort: any failure
    // just ships the base report, so our own SLA is never endangered.
    const enrichCandidates = route(registry, ENRICH_CAPABILITY).filter((c) => c.serviceId !== SERVICE_ID);
    if (enrichCandidates.length) {
      console.log(`🔗 Enriching via router — ${explainRoute(enrichCandidates, ENRICH_CAPABILITY)}`);
      const annex = await hireForCapability(
        client,
        stream,
        registry,
        ENRICH_CAPABILITY,
        negotiation.requirements,
        UPSTREAM_TIMEOUT_MS,
        SERVICE_ID
      );
      if (annex) {
        report.upstream = annex;
        report.sources.push(annex.source);
      }
    }

    await client.deliverOrder(orderId, {
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(toDeliverable(report)),
    });

    const annexNote = report.upstream
      ? ` incl. ${report.upstream.tier} annex from ${report.upstream.agentName}`
      : "";
    console.log(
      `📦 Delivered order ${orderId}: risk=${report.riskLevel} (${report.riskScore}/100), ` +
        `${report.sources.length} source(s)${annexNote}. ` +
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
  const registry = loadRegistry();
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, (ev) => void handleNegotiation(client, ev));
  stream.on(EventType.OrderPaid, (ev) => void handlePaid(client, stream, registry, ev));

  stream.on(EventType.OrderCompleted, (ev) =>
    console.log(`🎉 Order ${ev.order_id} completed — USDC settled to provider wallet.`)
  );
  stream.on(EventType.OrderExpired, (ev) =>
    console.warn(`⌛ Order ${ev.order_id} expired (SLA missed / unpaid).`)
  );

  console.log("🟢 Quanta provider online. Listening for orders on CAP...");
  const enrichCandidates = route(registry, ENRICH_CAPABILITY).filter((c) => c.serviceId !== SERVICE_ID);
  if (enrichCandidates.length) {
    console.log(`🔗 Router enrichment enabled — ${explainRoute(enrichCandidates, ENRICH_CAPABILITY)}`);
  }

  // Keep the process alive; EventStream auto-reconnects internally.
  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down provider.");
    stream.close();
    process.exit(0);
  });
}

// Only start the provider loop when run directly; importing (e.g. from tests)
// exposes the pure helpers above without opening a websocket.
if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
