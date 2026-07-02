// Report schema for the Token Due-Diligence service.
// Design principle: EVERY factual claim carries a `source` so the buyer (human
// or another agent) can independently verify it. This is the differentiator for
// the CROO "Research & Intelligence" track — paid research with verifiable sources.

export interface Source {
  /** Human/agent-readable name of the origin, e.g. "DexScreener". */
  provider: string;
  /** Direct, re-fetchable URL that backs the claim. */
  url: string;
  /** ISO-8601 time the data was fetched. */
  fetchedAt: string;
}

/** A single datum plus the source that proves it. */
export interface Cited<T> {
  value: T;
  source: Source;
}

export interface ResearchInput {
  /** Chain slug as used by DexScreener, e.g. "ethereum", "base", "solana", "bsc". */
  chain: string;
  /** Token contract address (preferred) OR a symbol/name to search. */
  token: string;
}

/**
 * HOW the token was identified — disclosed so the buyer can audit resolution
 * itself. Symbol search is impersonation-prone; address input is unambiguous.
 */
export interface Resolution {
  method: "address" | "symbol-search";
  /** Distinct token contracts that matched the input on the requested chain. */
  candidateTokens: number;
  note: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskFlag {
  code: string;
  level: RiskLevel;
  message: string;
  source?: Source;
}

export interface TokenReport {
  schemaVersion: "1.0";
  input: ResearchInput;
  resolved: {
    name: Cited<string>;
    symbol: Cited<string>;
    address: string;
    chain: string;
    /** DEX + pair the figures come from — lets buyers re-check the exact pool. */
    dexId: string;
    pairAddress: string;
  };
  resolution: Resolution;
  market: {
    priceUsd: Cited<number>;
    fdvUsd?: Cited<number>;
    liquidityUsd: Cited<number>;
    volume24hUsd: Cited<number>;
    priceChange24hPct?: Cited<number>;
    pairCreatedAt?: Cited<string>;
  };
  /**
   * Contract-behavior verification (EVM only, via on-chain buy/sell simulation).
   * Absent for non-EVM chains or when the simulation could not be run — its
   * absence is itself informative and surfaced as a flag.
   */
  contract?: {
    isHoneypot: Cited<boolean>;
    buyTaxPct?: Cited<number>;
    sellTaxPct?: Cited<number>;
    transferTaxPct?: Cited<number>;
    simulationSuccess: Cited<boolean>;
  };
  /**
   * A2A enrichment annex: the deliverable of ANOTHER CAP agent this agent
   * hired (and paid) as part of fulfilling the order. contentHash is the
   * upstream order's own on-chain commitment, so the chain of custody is
   * verifiable end-to-end. Present only when upstream hiring is configured
   * and the upstream order settled in time.
   */
  upstream?: {
    serviceId: string;
    orderId: string;
    contentHash: string;
    deliverable: unknown;
    source: Source;
  };
  riskScore: number; // 0 (safe) .. 100 (critical)
  riskLevel: RiskLevel;
  flags: RiskFlag[];
  /** Optional natural-language analyst summary (present only if Claude layer enabled). */
  summary?: string;
  /** All sources referenced anywhere in the report, de-duplicated. */
  sources: Source[];
  generatedAt: string;
  /** Set by the provider after delivery; lets buyers cross-check on-chain proof. */
  contentNote: string;
}
