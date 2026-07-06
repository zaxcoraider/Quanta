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

/**
 * Which dimension a flag belongs to, so the score can be broken down per
 * category instead of collapsing to a single opaque number. "positive" carries
 * legitimacy signals (e.g. CEX listing) that argue *against* risk.
 */
export type FlagCategory = "market" | "contract" | "holders" | "resolution" | "positive";

export interface RiskFlag {
  code: string;
  level: RiskLevel;
  category: FlagCategory;
  message: string;
  source?: Source;
}

/** A 0..100 risk score plus its bucketed level, for one category. */
export interface CategoryScore {
  score: number;
  level: RiskLevel;
}

/** How much of the report's evidence base actually resolved. */
export type Confidence = "high" | "medium" | "low";

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
   * Holder-distribution & ownership verification (EVM only, via GoPlus Labs).
   * Covers the dimension DexScreener and the buy/sell simulation miss: supply
   * concentration among top holders, LP-lock share, residual owner/creator
   * holdings, and dangerous retained authorities (mintable, ownership take-back,
   * hidden owner). Absent for non-EVM chains or when GoPlus returned nothing —
   * its absence is itself surfaced as a flag.
   */
  holders?: {
    holderCount?: Cited<number>;
    topHolderConcentrationPct?: Cited<number>;
    lpLockedPct?: Cited<number>;
    ownerPercentPct?: Cited<number>;
    creatorPercentPct?: Cited<number>;
    isMintable?: Cited<boolean>;
    canTakeBackOwnership?: Cited<boolean>;
    hiddenOwner?: Cited<boolean>;
    isOpenSource?: Cited<boolean>;
  };
  /**
   * Contract-capability surface (via GoPlus Labs). The dangerous powers a token
   * *retains* — distinct from how it currently behaves. On EVM these are Solidity
   * owner functions; on Solana they are SPL / Token-2022 authorities. EVM
   * owner-gated powers (pausable, blacklist, balance-change…) are only live when
   * `ownershipRenounced` is false, so a renounced token isn't penalised for
   * dormant code. `cexListed` / `trustedToken` are legitimacy signals, not risks.
   */
  security?: {
    // EVM (Solidity) capabilities
    ownershipRenounced?: Cited<boolean>;
    isProxy?: Cited<boolean>;
    selfdestruct?: Cited<boolean>;
    externalCall?: Cited<boolean>;
    transferPausable?: Cited<boolean>;
    canBlacklist?: Cited<boolean>;
    isWhitelisted?: Cited<boolean>;
    ownerCanChangeBalance?: Cited<boolean>;
    slippageModifiable?: Cited<boolean>;
    tradingCooldown?: Cited<boolean>;
    cannotSellAll?: Cited<boolean>;
    cannotBuy?: Cited<boolean>;
    creatorPriorHoneypot?: Cited<boolean>;
    goplusIsHoneypot?: Cited<boolean>;
    cexListed?: Cited<boolean>;
    cexList?: Cited<string[]>;
    // Solana (SPL / Token-2022) authorities & extensions
    freezeAuthorityActive?: Cited<boolean>;
    nonTransferable?: Cited<boolean>;
    transferHook?: Cited<boolean>;
    transferFee?: Cited<boolean>;
    metadataMutable?: Cited<boolean>;
    metadataMaliciousAuthority?: Cited<boolean>;
    trustedToken?: Cited<boolean>;
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
    /** Which capability this hop fulfilled (e.g. "due-diligence"). */
    capability?: string;
    /** The agent that delivered it, for the routing audit trail. */
    agentName?: string;
    /** internal = own ecosystem, store = hired from outside the ecosystem. */
    tier?: "internal" | "store";
  };
  riskScore: number; // 0 (safe) .. 100 (critical) — overall, across all signals
  riskLevel: RiskLevel;
  /**
   * Per-dimension breakdown so buyers see WHERE the risk sits, not just a single
   * number. Each is scored independently from that category's flags.
   */
  scores: {
    market: CategoryScore;
    contract: CategoryScore;
    holders: CategoryScore;
  };
  /**
   * How complete the evidence base was. "high" = all three sources resolved;
   * lower when the contract sim and/or holder data were unavailable (e.g.
   * non-EVM chain), so a "low" overall score with "low" confidence is not the
   * same as a vetted clean bill of health.
   */
  confidence: Confidence;
  confidenceNote: string;
  flags: RiskFlag[];
  /** Optional natural-language analyst summary (present only if Claude layer enabled). */
  summary?: string;
  /** All sources referenced anywhere in the report, de-duplicated. */
  sources: Source[];
  generatedAt: string;
  /** Set by the provider after delivery; lets buyers cross-check on-chain proof. */
  contentNote: string;
}
