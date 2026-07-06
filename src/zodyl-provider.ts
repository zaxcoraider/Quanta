// Zodyl — Portfolio & Watchlist Risk Intelligence (the ecosystem's 2nd agent).
//
// Zodyl is a CAP provider in its own right, but it does NO token analysis itself.
// For every token in a buyer's watchlist it HIRES Quanta's due-diligence service
// (routed through the ecosystem registry — internal Quanta first, open store as
// fallback), pays USDC, and aggregates the per-token reports into one portfolio
// risk verdict. Each sub-report carries the on-chain contentHash of the Quanta
// order that produced it, so the whole portfolio is verifiable hop by hop.
//
// This is the A2A supply chain made real, in BOTH directions:
//   buyer → Zodyl (portfolio) → Quanta (due-diligence, per token) → data sources
//
// Pure helpers (parse/aggregate/render) are exported and unit-tested; the CAP
// loop only runs when this file is executed directly.

import { EventType, type AgentClient, type Event } from "@croo-network/sdk";
import {
  zodylClient,
  ZODYL_SERVICE_ID,
  UPSTREAM_TIMEOUT_MS,
  loadRegistry,
} from "./config";
import { hireForCapability, type UpstreamAnnex } from "./upstream";
import type { AgentServiceEntry } from "./registry";

// ----------------------------------------------------------------- pure core

export interface PortfolioInput {
  chain: string;
  tokens: string[];
}

export interface TokenVerdict {
  token: string;
  ok: boolean;
  riskScore?: number;
  riskLevel?: string;
  confidence?: string;
  topFlags?: string[];
  /** The Quanta order's on-chain proof for THIS token — per-token chain of custody. */
  contentHash?: string;
  orderId?: string;
  /** Who fulfilled it: "Quanta" (internal) or a store agent (fallback). */
  fulfilledBy?: string;
  tier?: "internal" | "store";
  error?: string;
}

export interface PortfolioReport {
  schemaVersion: "1.0";
  chain: string;
  tokenCount: number;
  scanned: number; // how many tokens Quanta actually returned a report for
  portfolioRiskScore: number; // headline = the riskiest holding (portfolio is as risky as its worst)
  portfolioRiskLevel: string;
  averageRiskScore: number;
  riskiest?: { token: string; riskScore: number; riskLevel: string };
  distribution: { low: number; medium: number; high: number; critical: number };
  tokens: TokenVerdict[];
  provenance: {
    provider: "Zodyl";
    composed: string;
    /** Per-token on-chain proofs — the verifiable A2A supply chain. */
    contentHashes: string[];
  };
  generatedAt: string;
  note: string;
}

/** Same bucketing as the Quanta engine (risk.ts levelFor), kept in sync here. */
export function levelForScore(score: number): "low" | "medium" | "high" | "critical" {
  return score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
}

/**
 * Parse a buyer's requirements into a bounded PortfolioInput.
 * Accepts tokens as a JSON array OR a comma/space/newline-separated string, so
 * the service is forgiving about how a watchlist is expressed. Capped at `max`
 * tokens to bound cost and stay inside the SLA.
 */
export function parsePortfolioInput(raw: any, max = 25): PortfolioInput {
  if (!raw || typeof raw !== "object") {
    throw new Error('Requirements must be JSON like {"chain":"base","tokens":["0x..","WETH"]}');
  }
  const chain = String(raw.chain ?? "").trim();
  if (!chain) throw new Error('Missing "chain" (e.g. "ethereum", "base", "bsc", "solana").');

  let tokens: string[] = [];
  const t = raw.tokens ?? raw.watchlist ?? raw.token;
  if (Array.isArray(t)) {
    tokens = t.map((x) => String(x).trim());
  } else if (typeof t === "string") {
    tokens = t.split(/[\s,]+/).map((x) => x.trim());
  }
  tokens = tokens.filter(Boolean);
  // De-dupe (case-insensitive) while preserving order.
  const seen = new Set<string>();
  tokens = tokens.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (tokens.length === 0) throw new Error('Missing "tokens" — a non-empty watchlist of addresses/symbols.');
  if (tokens.length > max) throw new Error(`Too many tokens (${tokens.length} > ${max}). Split the watchlist.`);
  return { chain, tokens };
}

/** Pull the fields Zodyl needs out of one Quanta annex (deliverable + hash). */
export function verdictFromAnnex(token: string, annex: UpstreamAnnex): TokenVerdict {
  const d: any = annex.deliverable ?? {};
  const riskScore = typeof d.riskScore === "number" ? d.riskScore : undefined;
  // Quanta renders flags to strings ("CODE | level | category | msg | source: url").
  const topFlags = Array.isArray(d.flags)
    ? d.flags.slice(0, 3).map((f: any) => (typeof f === "string" ? f.split(" | ")[0] : f?.code)).filter(Boolean)
    : undefined;
  return {
    token,
    ok: true,
    riskScore,
    riskLevel: typeof d.riskLevel === "string" ? d.riskLevel : riskScore !== undefined ? levelForScore(riskScore) : undefined,
    confidence: typeof d.confidence === "string" ? d.confidence : undefined,
    topFlags,
    contentHash: annex.contentHash,
    orderId: annex.orderId,
    fulfilledBy: annex.agentName,
    tier: annex.tier,
  };
}

/** Aggregate per-token verdicts into one portfolio report. Pure. */
export function aggregatePortfolio(chain: string, verdicts: TokenVerdict[]): PortfolioReport {
  const scored = verdicts.filter((v) => v.ok && typeof v.riskScore === "number");
  const scanned = scored.length;

  const distribution = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const v of scored) {
    const lvl = (v.riskLevel as keyof typeof distribution) ?? levelForScore(v.riskScore!);
    if (lvl in distribution) distribution[lvl]++;
  }

  const scores = scored.map((v) => v.riskScore!);
  const portfolioRiskScore = scores.length ? Math.max(...scores) : 0;
  const averageRiskScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  let riskiest: PortfolioReport["riskiest"];
  if (scored.length) {
    const worst = scored.reduce((a, b) => (b.riskScore! > a.riskScore! ? b : a));
    riskiest = { token: worst.token, riskScore: worst.riskScore!, riskLevel: worst.riskLevel ?? levelForScore(worst.riskScore!) };
  }

  const contentHashes = scored.map((v) => v.contentHash).filter((h): h is string => !!h);

  return {
    schemaVersion: "1.0",
    chain,
    tokenCount: verdicts.length,
    scanned,
    portfolioRiskScore,
    portfolioRiskLevel: levelForScore(portfolioRiskScore),
    averageRiskScore,
    riskiest,
    distribution,
    tokens: verdicts,
    provenance: {
      provider: "Zodyl",
      composed: "Quanta due-diligence per token (A2A, USDC-settled)",
      contentHashes,
    },
    generatedAt: new Date().toISOString(),
    note:
      "Portfolio risk = the riskiest holding (a portfolio is only as safe as its worst token). " +
      "Every per-token verdict is a paid Quanta due-diligence order; its contentHash is that order's " +
      "on-chain commitment, so the whole scan is verifiable hop by hop.",
  };
}

/** Render one verdict to a primitive string (CAP schema arrays take primitives). */
export function renderVerdict(v: TokenVerdict): string {
  if (!v.ok) return `${v.token} | ERROR | ${v.error ?? "no report"}`;
  const flags = v.topFlags?.length ? ` | flags: ${v.topFlags.join(",")}` : "";
  return `${v.token} | ${v.riskLevel ?? "?"} | ${v.riskScore ?? "?"}/100 | conf ${v.confidence ?? "?"} | ` +
    `via ${v.fulfilledBy ?? "?"}[${v.tier ?? "?"}] | hash ${v.contentHash ?? "-"}${flags}`;
}

/** Project a PortfolioReport onto a CAP-safe deliverable (string[] arrays). */
export function toPortfolioDeliverable(report: PortfolioReport): Record<string, unknown> {
  return {
    ...report,
    tokens: report.tokens.map(renderVerdict),
  };
}

// -------------------------------------------------------------- CAP provider

type Stream = Awaited<ReturnType<AgentClient["connectWebSocket"]>>;

const seenNegotiations = new Set<string>();
const seenPaidOrders = new Set<string>();

export async function handleNegotiation(client: AgentClient, ev: Event) {
  const negotiationId = ev.negotiation_id;
  if (!negotiationId || seenNegotiations.has(negotiationId)) return;
  seenNegotiations.add(negotiationId);
  try {
    const negotiation = await client.getNegotiation(negotiationId);
    // Only fulfill OUR own service; anything else on this stream is a hire we
    // initiated (Zodyl hiring Quanta) where we are the requester.
    if (ZODYL_SERVICE_ID && negotiation.serviceId !== ZODYL_SERVICE_ID) return;
    try {
      parsePortfolioInput(JSON.parse(negotiation.requirements || "{}"));
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
    if (ZODYL_SERVICE_ID && order.serviceId !== ZODYL_SERVICE_ID) return;

    const negotiation = await client.getNegotiation(order.negotiationId);
    const input = parsePortfolioInput(JSON.parse(negotiation.requirements || "{}"));
    console.log(`📊 Order ${orderId} paid. Scanning ${input.tokens.length} token(s) on ${input.chain} — hiring Quanta per token...`);

    // Hire due-diligence for each token, sequentially (bounded per token) so the
    // requester wallet's nonces stay clean and one slow token can't stall others.
    const verdicts: TokenVerdict[] = [];
    for (const token of input.tokens) {
      const requirements = JSON.stringify({ chain: input.chain, token });
      const annex = await hireForCapability(
        client,
        stream,
        registry,
        "due-diligence",
        requirements,
        UPSTREAM_TIMEOUT_MS,
        ZODYL_SERVICE_ID
      );
      verdicts.push(
        annex
          ? verdictFromAnnex(token, annex)
          : { token, ok: false, error: "no due-diligence provider delivered in time" }
      );
    }

    const report = aggregatePortfolio(input.chain, verdicts);
    await client.deliverOrder(orderId, {
      deliverableType: "schema",
      deliverableSchema: JSON.stringify(toPortfolioDeliverable(report)),
    });
    console.log(
      `📦 Delivered portfolio ${orderId}: ${report.scanned}/${report.tokenCount} scanned, ` +
        `risk=${report.portfolioRiskLevel} (${report.portfolioRiskScore}/100), ` +
        `${report.provenance.contentHashes.length} on-chain proof(s).`
    );
  } catch (e: any) {
    console.error(`❌ Delivery failed for order ${orderId}: ${e.message}`);
    try {
      await client.rejectOrder(orderId, `Provider error: ${e.message}`.slice(0, 200));
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  const client = zodylClient();
  const registry = loadRegistry();
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, (ev) => void handleNegotiation(client, ev));
  stream.on(EventType.OrderPaid, (ev) => void handlePaid(client, stream, registry, ev));
  stream.on(EventType.OrderCompleted, (ev) =>
    console.log(`🎉 Order ${ev.order_id} completed — USDC settled to Zodyl wallet.`)
  );
  stream.on(EventType.OrderExpired, (ev) =>
    console.warn(`⌛ Order ${ev.order_id} expired (SLA missed / unpaid).`)
  );

  console.log("🟢 Zodyl portfolio agent online. Composing Quanta per token on CAP...");
  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down Zodyl.");
    stream.close();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
