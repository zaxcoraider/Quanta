// The ecosystem registry + capability router — Quanta's "CEO brain".
//
// Quanta doesn't do every job itself. It owns the customer relationship and
// ROUTES each needed capability to a specialist agent: hire from its OWN
// ecosystem first (Zodyl, and later Rudo for images, a code agent, …), and only
// when no in-house agent covers a capability does it fall back to the open CROO
// store. Every hop is still a real CAP order — USDC-settled and verifiable — so
// the whole agent supply chain has a chain of custody hop by hop.
//
// This module is the pure decision layer: given a capability, produce an ordered
// list of candidate services to try. The actual hiring/paying is the transport
// in upstream.ts (hireForCapability walks this list until one delivers). Kept
// dependency-free and env-injectable so it unit-tests with no process.env / fs.

/** internal = an agent WE deploy (the ecosystem). store = an outside agent. */
export type Tier = "internal" | "store";

/** One hireable service, tagged with the capability it provides and its tier. */
export interface AgentServiceEntry {
  /** Capability slug, e.g. "due-diligence", "portfolio-scan", "image", "code". */
  capability: string;
  /** CAP service id to negotiate against. */
  serviceId: string;
  /** Human-readable agent name, for logs and the routing audit trail. */
  agentName: string;
  /** internal (own ecosystem) is always preferred over store. */
  tier: Tier;
  /** Informational USDC price; used only to break ties within a tier. */
  price?: number;
  /** Optional free-text note (what this agent is / why it's here). */
  note?: string;
}

/**
 * Build the registry from a plain env-like map (so tests pass an object, prod
 * passes process.env) plus any extra entries (e.g. loaded from registry.json).
 *
 * Ecosystem agents are declared by their service-id env vars:
 *   - CROO_SERVICE_ID          -> Quanta,  capability "due-diligence" (internal)
 *   - CROO_ZODYL_SERVICE_ID    -> Zodyl,   capability "portfolio-scan" (internal)
 *   - (future: CROO_RUDO_SERVICE_ID -> Rudo, "image", …)
 *
 * Store fallbacks are declared as JSON in CROO_STORE_SERVICES, an array of
 * {capability, serviceId, agentName?, price?, note?}. And for backward-compat
 * the legacy single hook CROO_UPSTREAM_SERVICE_ID is folded in as a store entry
 * for CROO_UPSTREAM_CAPABILITY (default "due-diligence").
 *
 * Entries are de-duplicated by (capability, serviceId); the FIRST occurrence
 * wins, so `extra` (registry.json) can be overridden by more specific env, and
 * an internal entry always shadows a store entry for the same service id.
 */
export function buildRegistry(
  env: Record<string, string | undefined>,
  extra: AgentServiceEntry[] = []
): AgentServiceEntry[] {
  const out: AgentServiceEntry[] = [];

  // --- Ecosystem (internal) agents, from their service-id env vars ---
  const ecosystem: Array<Omit<AgentServiceEntry, "tier"> & { key: string }> = [
    {
      key: "CROO_SERVICE_ID",
      capability: "due-diligence",
      serviceId: "",
      agentName: "Quanta",
      note: "Verifiable token due-diligence — the ecosystem's research core.",
    },
    {
      key: "CROO_ZODYL_SERVICE_ID",
      capability: "portfolio-scan",
      serviceId: "",
      agentName: "Zodyl",
      note: "Portfolio / watchlist risk intelligence (composes Quanta per token).",
    },
  ];
  for (const e of ecosystem) {
    const serviceId = (env[e.key] || "").trim();
    if (serviceId) {
      out.push({
        capability: e.capability,
        serviceId,
        agentName: e.agentName,
        tier: "internal",
        note: e.note,
      });
    }
  }

  // --- Store (external) fallbacks, from CROO_STORE_SERVICES JSON ---
  const rawStore = (env.CROO_STORE_SERVICES || "").trim();
  if (rawStore) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStore);
    } catch {
      throw new Error("CROO_STORE_SERVICES must be a JSON array of {capability, serviceId, …}.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("CROO_STORE_SERVICES must be a JSON array.");
    }
    for (const item of parsed as any[]) {
      if (!item || !item.capability || !item.serviceId) continue;
      out.push({
        capability: String(item.capability),
        serviceId: String(item.serviceId),
        agentName: String(item.agentName || "store agent"),
        tier: "store",
        price: item.price !== undefined ? Number(item.price) : undefined,
        note: item.note ? String(item.note) : "External store agent (outside the ecosystem).",
      });
    }
  }

  // --- Legacy single hook: CROO_UPSTREAM_SERVICE_ID -> a store entry ---
  const legacy = (env.CROO_UPSTREAM_SERVICE_ID || "").trim();
  if (legacy) {
    out.push({
      capability: (env.CROO_UPSTREAM_CAPABILITY || "due-diligence").trim(),
      serviceId: legacy,
      agentName: "upstream (CROO_UPSTREAM_SERVICE_ID)",
      tier: "store",
      note: "Legacy single-hook upstream, folded into the router as a store entry.",
    });
  }

  // --- Caller-supplied extras (e.g. registry.json) ---
  out.push(...extra);

  // De-dupe by (capability, serviceId); first occurrence wins.
  const seen = new Set<string>();
  const deduped: AgentServiceEntry[] = [];
  for (const e of out) {
    const k = `${e.capability}|${e.serviceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }
  return deduped;
}

/**
 * The routing decision: candidate services for a capability, best-first.
 *
 * Ordering encodes the ecosystem policy:
 *   1. internal (own agents) before store (outside) — ALWAYS;
 *   2. within a tier, cheaper first (undefined price sorts last);
 *   3. stable otherwise (registration order preserved).
 *
 * hireForCapability walks this list and hires the first candidate that actually
 * delivers, so a down/expired internal agent still degrades to the store.
 */
export function route(registry: AgentServiceEntry[], capability: string): AgentServiceEntry[] {
  const tierRank = (t: Tier) => (t === "internal" ? 0 : 1);
  const priceRank = (p?: number) => (p === undefined || Number.isNaN(p) ? Number.POSITIVE_INFINITY : p);
  return registry
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.capability === capability)
    .sort((a, b) => {
      const t = tierRank(a.e.tier) - tierRank(b.e.tier);
      if (t !== 0) return t;
      const p = priceRank(a.e.price) - priceRank(b.e.price);
      if (p !== 0) return p;
      return a.i - b.i; // stable
    })
    .map((x) => x.e);
}

/** All distinct capabilities the ecosystem (or its store fallbacks) can serve. */
export function capabilities(registry: AgentServiceEntry[]): string[] {
  return [...new Set(registry.map((e) => e.capability))].sort();
}

/** One-line audit string for a routing decision, for provider logs / the demo. */
export function explainRoute(candidates: AgentServiceEntry[], capability: string): string {
  if (candidates.length === 0) {
    return `no agent (internal or store) offers "${capability}"`;
  }
  const chain = candidates
    .map((c) => `${c.agentName}[${c.tier}]${c.serviceId ? " " + c.serviceId : ""}`)
    .join(" → ");
  return `"${capability}": ${chain}`;
}
