// A2A upstream enrichment: while fulfilling a paid order, THIS agent hires
// ANOTHER CAP agent (any store service you point it at), pays USDC from its
// own AA wallet, and attaches the upstream deliverable — with the upstream
// order's own on-chain contentHash — as a cited annex in the report.
//
// That makes the agent both a CAP provider AND a CAP requester in the same
// transaction: a real supply chain of agents, with a verifiable chain of
// custody at every hop.
//
// Design constraints:
//   - Strictly optional: enabled only when CROO_UPSTREAM_SERVICE_ID is set.
//   - Strictly bounded: hard timeout so our own SLA is never endangered.
//   - Never throws: any failure (reject, expiry, timeout, network) returns
//     null and the base report is delivered as usual.
//   - No listener leak: EventStream has no off(), so we attach exactly six
//     listeners per stream ONCE and fan every event out to the set of hires
//     currently in flight. A long-lived provider that serves thousands of
//     orders keeps six listeners, not six-per-order.

import { EventType, type AgentClient, type Event } from "@croo-network/sdk";
import type { Source, TokenReport } from "./engine/types";

type Stream = Awaited<ReturnType<AgentClient["connectWebSocket"]>>;
export type UpstreamAnnex = NonNullable<TokenReport["upstream"]>;

// One in-flight hire's reactions to each event kind. hireUpstream registers a
// HireReactions into `activeHires` and deletes it on settle, so the set size is
// bounded by CONCURRENT hires, never by lifetime order count.
interface HireReactions {
  onNegotiationRejected(ev: Event): void;
  onNegotiationExpired(ev: Event): void;
  onOrderCreated(ev: Event): void;
  onOrderCompleted(ev: Event): void;
  onOrderRejected(ev: Event): void;
  onOrderExpired(ev: Event): void;
}

const activeHires = new Set<HireReactions>();

// Streams we have already attached the six shared listeners to. A WeakSet so a
// closed stream can be GC'd without leaking a key here.
const wiredStreams = new WeakSet<object>();

function wireStream(stream: Stream): void {
  if (wiredStreams.has(stream)) return;
  wiredStreams.add(stream);
  const fan =
    (key: keyof HireReactions) =>
    (ev: Event): void => {
      // Snapshot first: a hire may delete itself from the set while dispatching.
      for (const hire of [...activeHires]) hire[key](ev);
    };
  stream.on(EventType.NegotiationRejected, fan("onNegotiationRejected"));
  stream.on(EventType.NegotiationExpired, fan("onNegotiationExpired"));
  stream.on(EventType.OrderCreated, fan("onOrderCreated"));
  stream.on(EventType.OrderCompleted, fan("onOrderCompleted"));
  stream.on(EventType.OrderRejected, fan("onOrderRejected"));
  stream.on(EventType.OrderExpired, fan("onOrderExpired"));
}

/** Test-only: how many hires are currently registered on the shared stream. */
export function _activeHireCount(): number {
  return activeHires.size;
}

export async function hireUpstream(
  client: AgentClient,
  stream: Stream,
  serviceId: string,
  requirements: string,
  timeoutMs: number
): Promise<UpstreamAnnex | null> {
  wireStream(stream);

  return new Promise<UpstreamAnnex | null>((resolve) => {
    let done = false;
    let negotiationId = "";
    let orderId = "";

    // negotiateOrder() resolves after events can already be flowing; handlers
    // await this so a fast upstream accept can't slip past the ID check.
    let negotiationReady!: () => void;
    const negotiationKnown = new Promise<void>((r) => (negotiationReady = r));

    // Declared up front so settle() can remove this hire from the shared set.
    const reactions = {} as HireReactions;

    const settle = (annex: UpstreamAnnex | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeHires.delete(reactions);
      resolve(annex);
    };

    const timer = setTimeout(() => {
      console.warn(`   ↳ upstream ${serviceId}: timed out after ${timeoutMs / 1000}s — delivering without annex.`);
      settle(null);
    }, timeoutMs);
    timer.unref?.();

    const isOurs = (ev: Event) =>
      (ev.negotiation_id && ev.negotiation_id === negotiationId) ||
      (ev.order_id && ev.order_id === orderId);

    reactions.onNegotiationRejected = (ev) => {
      if (done || !isOurs(ev)) return;
      console.warn(`   ↳ upstream ${serviceId}: negotiation rejected: ${ev.reason || ""}`);
      settle(null);
    };

    reactions.onNegotiationExpired = (ev) => {
      if (done || !isOurs(ev)) return;
      settle(null);
    };

    reactions.onOrderCreated = async (ev) => {
      if (done || !ev.order_id || orderId) return;
      await negotiationKnown;
      let evNegotiationId = ev.negotiation_id;
      if (!evNegotiationId) {
        try {
          evNegotiationId = (await client.getOrder(ev.order_id)).negotiationId;
        } catch {
          return;
        }
      }
      if (evNegotiationId !== negotiationId || done) return;
      orderId = ev.order_id;
      try {
        const res = await client.payOrder(orderId);
        console.log(`   ↳ upstream ${serviceId}: order ${orderId} paid (tx ${res.txHash}).`);
      } catch (e: any) {
        console.warn(`   ↳ upstream ${serviceId}: payment failed: ${e.message}`);
        settle(null);
      }
    };

    reactions.onOrderCompleted = async (ev) => {
      if (done || !ev.order_id || ev.order_id !== orderId) return;
      try {
        const delivery = await client.getDelivery(orderId);
        let deliverable: unknown = delivery.deliverableText || delivery.deliverableSchema;
        try {
          deliverable = JSON.parse(delivery.deliverableSchema);
        } catch {
          /* leave as text */
        }
        const source: Source = {
          provider: `CAP service ${serviceId}`,
          url: "https://agent.croo.network/",
          fetchedAt: new Date().toISOString(),
        };
        console.log(`   ↳ upstream ${serviceId}: delivered, contentHash ${delivery.contentHash}.`);
        settle({ serviceId, orderId, contentHash: delivery.contentHash, deliverable, source });
      } catch (e: any) {
        console.warn(`   ↳ upstream ${serviceId}: could not fetch delivery: ${e.message}`);
        settle(null);
      }
    };

    reactions.onOrderRejected = (ev) => {
      if (done || !isOurs(ev)) return;
      settle(null);
    };

    reactions.onOrderExpired = (ev) => {
      if (done || !isOurs(ev)) return;
      settle(null);
    };

    activeHires.add(reactions);

    client
      .negotiateOrder({ serviceId, requirements })
      .then((n) => {
        negotiationId = n.negotiationId;
        negotiationReady();
        console.log(`   ↳ upstream ${serviceId}: negotiation ${negotiationId} opened.`);
      })
      .catch((e: any) => {
        console.warn(`   ↳ upstream ${serviceId}: negotiate failed: ${e.message}`);
        settle(null);
      });
  });
}
