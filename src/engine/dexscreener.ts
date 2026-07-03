// Data source: DexScreener public API — free, no API key, live market data
// across most EVM chains + Solana. We use it because the agent must run live
// during the demo without any private keys, and because it returns URLs we can
// cite back to the buyer for verifiability.
//
// Docs: https://docs.dexscreener.com/api/reference

import { fetchJson } from "./http";
import type { Resolution, Source } from "./types";

const BASE = "https://api.dexscreener.com";

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number; // ms epoch
}

// DexScreener is the one required source, so it gets a couple of retries.
async function getJson(url: string): Promise<{ data: any; fetchedAt: string }> {
  const { data, fetchedAt } = await fetchJson<any>(url, { retries: 2 });
  return { data, fetchedAt };
}

/** One candidate token (grouped by contract address) during symbol resolution. */
export interface TokenCandidate {
  address: string;
  symbol: string;
  pairs: DexPair[];
  pairCount: number;
  totalLiquidityUsd: number;
  oldestPairCreatedAt?: number; // ms epoch; undefined if unknown
}

export function groupByToken(pairs: DexPair[]): TokenCandidate[] {
  const byAddr = new Map<string, TokenCandidate>();
  for (const p of pairs) {
    const addr = p.baseToken?.address;
    if (!addr) continue;
    let c = byAddr.get(addr);
    if (!c) {
      c = {
        address: addr,
        symbol: p.baseToken.symbol,
        pairs: [],
        pairCount: 0,
        totalLiquidityUsd: 0,
        oldestPairCreatedAt: undefined,
      };
      byAddr.set(addr, c);
    }
    c.pairs.push(p);
    c.pairCount += 1;
    c.totalLiquidityUsd += p.liquidity?.usd ?? 0;
    if (
      p.pairCreatedAt &&
      (c.oldestPairCreatedAt === undefined || p.pairCreatedAt < c.oldestPairCreatedAt)
    ) {
      c.oldestPairCreatedAt = p.pairCreatedAt;
    }
  }
  return [...byAddr.values()];
}

/**
 * Pick the most likely CANONICAL token among same-symbol candidates.
 *
 * Threat model: impersonator tokens routinely spoof a huge single-pair
 * "liquidity" number (price is manipulable on a fake token, and reported
 * liquidity is priced reserves), so raw deepest-liquidity is NOT safe.
 * Canonical tokens instead look like: many independent pairs + a long trading
 * history. So we rank by pair count first, then by age of the oldest pair,
 * and only then by total liquidity. Transparent and auditable on purpose.
 */
export function pickCanonicalToken(candidates: TokenCandidate[]): TokenCandidate {
  const sorted = [...candidates].sort((a, b) => {
    if (b.pairCount !== a.pairCount) return b.pairCount - a.pairCount;
    const aAge = a.oldestPairCreatedAt ?? Number.MAX_SAFE_INTEGER;
    const bAge = b.oldestPairCreatedAt ?? Number.MAX_SAFE_INTEGER;
    if (aAge !== bAge) return aAge - bAge; // older (smaller epoch) first
    return b.totalLiquidityUsd - a.totalLiquidityUsd;
  });
  return sorted[0];
}

/** Deepest-liquidity pair within one token's pairs (safe once token is fixed). */
function deepestPair(pairs: DexPair[]): DexPair {
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

function looksLikeAddress(token: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(token) || token.length >= 32;
}

/**
 * Resolve the input to a trading pair on the REQUESTED chain (never silently
 * another chain — a due-diligence report for the wrong network is worse than
 * an error). Accepts a contract address (preferred, unambiguous) or a
 * free-text symbol/name (canonical-token heuristics + ambiguity disclosure).
 * Returns the chosen pair, the Source that backs it, and Resolution metadata
 * so the buyer can audit HOW the token was identified.
 */
export async function resolvePair(
  chain: string,
  token: string
): Promise<{ pair: DexPair; source: Source; resolution: Resolution }> {
  const isAddress = looksLikeAddress(token);
  const wantChain = chain.toLowerCase();

  let pairs: DexPair[] = [];
  let url: string;
  let fetchedAt: string;

  if (isAddress) {
    url = `${BASE}/latest/dex/tokens/${token}`;
    const res = await getJson(url);
    pairs = (res.data?.pairs ?? []) as DexPair[];
    fetchedAt = res.fetchedAt;
  } else {
    url = `${BASE}/latest/dex/search?q=${encodeURIComponent(token)}`;
    const res = await getJson(url);
    pairs = (res.data?.pairs ?? []) as DexPair[];
    fetchedAt = res.fetchedAt;
  }

  if (pairs.length === 0) {
    throw new Error(
      `No trading pair found for "${token}". Check the address/symbol ` +
        `(chains use DexScreener slugs, e.g. ethereum, base, bsc, solana).`
    );
  }

  const onChain = pairs.filter((p) => p.chainId?.toLowerCase() === wantChain);
  if (onChain.length === 0) {
    const chainsFound = [...new Set(pairs.map((p) => p.chainId?.toLowerCase()).filter(Boolean))];
    throw new Error(
      `"${token}" has no pairs on chain "${chain}". Pairs exist on: ${chainsFound.join(", ")}. ` +
        `Re-request with one of those chain slugs if that was the intent.`
    );
  }

  let pair: DexPair;
  let resolution: Resolution;

  if (isAddress) {
    pair = deepestPair(onChain);
    resolution = {
      method: "address",
      candidateTokens: 1,
      note: "Resolved by contract address (unambiguous); deepest-liquidity pair selected.",
    };
  } else {
    // Prefer exact symbol matches when any exist, so "PEPE" doesn't resolve
    // to "PEPE2.0" just because it reports more liquidity.
    const exact = onChain.filter(
      (p) => p.baseToken?.symbol?.toLowerCase() === token.toLowerCase()
    );
    const pool = exact.length > 0 ? exact : onChain;

    const candidates = groupByToken(pool);
    const chosen = pickCanonicalToken(candidates);
    pair = deepestPair(chosen.pairs);
    resolution = {
      method: "symbol-search",
      candidateTokens: candidates.length,
      note:
        `Symbol search matched ${candidates.length} distinct token contract(s) on ${wantChain}; ` +
        `picked the most-canonical by pair count (${chosen.pairCount}), oldest pair age, then total ` +
        `liquidity. Symbol input is impersonation-prone — re-request by contract address to remove ambiguity.`,
    };
  }

  return {
    pair,
    resolution,
    source: {
      provider: "DexScreener",
      // Cite the specific pair page so the buyer can eyeball the same numbers.
      url: pair.url || url,
      fetchedAt,
    },
  };
}
