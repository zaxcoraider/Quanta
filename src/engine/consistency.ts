// Cross-source price-consistency check — free, no API key, machine-re-fetchable.
//
// DexScreener gives ONE price, from ONE pool. That's manipulable: a spoofed
// token can post any price on a fake pool. This module cross-checks that price
// against two INDEPENDENT aggregators that address the token BY CONTRACT (never
// by symbol — symbol matching would reintroduce the impersonation risk we
// engineered away):
//   - DefiLlama  (coins.llama.fi)   — price + a confidence score, no key.
//   - CoinGecko  (api.coingecko.com) — price + market cap + 24h volume, no key.
//
// The signal is the AGREEMENT itself:
//   - all sources agree            -> legitimacy (positive) + higher trust
//   - priced on a DEX but on NO aggregator -> classic spoof / unlisted tell
//   - prices diverge materially    -> thin liquidity / manipulation / stale pool
//
// Every number stays citable to the exact JSON endpoint, so `npm run verify`
// re-fetches all of it. Non-supported chains or missing listings degrade to
// null / partial — never an error, never a blocked report.

import { fetchJson } from "./http";
import type { Source } from "./types";

// DefiLlama coin-price chain slugs (coins.llama.fi keys as "<chain>:<address>").
const LLAMA_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  eth: "ethereum",
  base: "base",
  bsc: "bsc",
  binance: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  avalanche: "avax",
  avax: "avax",
  solana: "solana",
};

// CoinGecko asset-platform ids for the /simple/token_price/{platform} endpoint.
const CG_PLATFORM: Record<string, string> = {
  ethereum: "ethereum",
  eth: "ethereum",
  base: "base",
  bsc: "binance-smart-chain",
  binance: "binance-smart-chain",
  polygon: "polygon-pos",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  avalanche: "avalanche",
  avax: "avalanche",
  solana: "solana",
};

export interface ConsistencyResult {
  /** True if at least one independent aggregator returned a price. */
  found: boolean;
  /** The reference price we cross-check against (DexScreener). */
  referencePriceUsd?: number;
  llamaPriceUsd?: number;
  /** DefiLlama's own 0..1 confidence in its price (proxy for liquidity/coverage). */
  llamaConfidence?: number;
  coingeckoPriceUsd?: number;
  /** Independent market cap (CoinGecko) — a legitimacy/size signal. */
  marketCapUsd?: number;
  /** Independent 24h volume (CoinGecko) — not derived from the DEX pool. */
  coingeckoVolume24hUsd?: number;
  /** How many independent price sources were available (incl. the reference). */
  pricedSources: number;
  /** Largest pairwise divergence across available prices, in percent. */
  maxDivergencePct?: number;
  /** Priced on at least one MAJOR aggregator (DefiLlama or CoinGecko). */
  aggregatorListed: boolean;
}

function num(x: unknown): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pure divergence/agreement computation over whatever prices resolved. Exported
 * for offline unit tests — no network here.
 */
export function computeConsistency(input: {
  referencePriceUsd?: number;
  llamaPriceUsd?: number;
  llamaConfidence?: number;
  coingeckoPriceUsd?: number;
  marketCapUsd?: number;
  coingeckoVolume24hUsd?: number;
}): ConsistencyResult {
  const prices = [input.referencePriceUsd, input.llamaPriceUsd, input.coingeckoPriceUsd].filter(
    (p): p is number => typeof p === "number" && p > 0
  );
  const aggregatorListed =
    (typeof input.llamaPriceUsd === "number" && input.llamaPriceUsd > 0) ||
    (typeof input.coingeckoPriceUsd === "number" && input.coingeckoPriceUsd > 0);

  let maxDivergencePct: number | undefined;
  if (prices.length >= 2) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    maxDivergencePct = min > 0 ? ((max - min) / min) * 100 : undefined;
  }

  return {
    found: aggregatorListed,
    referencePriceUsd: input.referencePriceUsd,
    llamaPriceUsd: input.llamaPriceUsd,
    llamaConfidence: input.llamaConfidence,
    coingeckoPriceUsd: input.coingeckoPriceUsd,
    marketCapUsd: input.marketCapUsd,
    coingeckoVolume24hUsd: input.coingeckoVolume24hUsd,
    pricedSources: prices.length,
    maxDivergencePct: maxDivergencePct !== undefined ? Math.round(maxDivergencePct * 100) / 100 : undefined,
    aggregatorListed,
  };
}

export interface ConsistencyCheck {
  result: ConsistencyResult;
  /** Per-aggregator citations (only for the ones that resolved). */
  llamaSource?: Source;
  coingeckoSource?: Source;
  /** A representative source for consistency-derived flags. */
  source: Source;
}

/**
 * Cross-check the reference (DexScreener) price against DefiLlama + CoinGecko.
 * Returns null when neither aggregator supports the chain / knows the token, so
 * the report is never blocked. Best-effort: either aggregator failing just drops
 * that one source.
 */
export async function checkConsistency(
  chain: string,
  address: string,
  referencePriceUsd?: number
): Promise<ConsistencyCheck | null> {
  const c = chain.toLowerCase();
  const llamaChain = LLAMA_CHAIN[c];
  const cgPlatform = CG_PLATFORM[c];
  if (!llamaChain && !cgPlatform) return null;
  if (!address) return null;

  const llamaUrl = llamaChain
    ? `https://coins.llama.fi/prices/current/${llamaChain}:${address}`
    : undefined;
  const cgUrl = cgPlatform
    ? `https://api.coingecko.com/api/v3/simple/token_price/${cgPlatform}` +
      `?contract_addresses=${address}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`
    : undefined;

  const [llama, cg] = await Promise.all([
    llamaUrl
      ? fetchJson<any>(llamaUrl, { retries: 1 }).catch(() => null)
      : Promise.resolve(null),
    cgUrl ? fetchJson<any>(cgUrl, { retries: 1 }).catch(() => null) : Promise.resolve(null),
  ]);

  let llamaPriceUsd: number | undefined;
  let llamaConfidence: number | undefined;
  let llamaSource: Source | undefined;
  if (llama?.data?.coins) {
    const entry = Object.values(llama.data.coins)[0] as any;
    llamaPriceUsd = num(entry?.price);
    llamaConfidence = num(entry?.confidence);
    if (llamaPriceUsd !== undefined && llamaUrl) {
      llamaSource = { provider: "DefiLlama", url: llamaUrl, fetchedAt: llama.fetchedAt };
    }
  }

  let coingeckoPriceUsd: number | undefined;
  let marketCapUsd: number | undefined;
  let coingeckoVolume24hUsd: number | undefined;
  let coingeckoSource: Source | undefined;
  if (cg?.data && typeof cg.data === "object") {
    const entry = Object.values(cg.data)[0] as any;
    coingeckoPriceUsd = num(entry?.usd);
    marketCapUsd = num(entry?.usd_market_cap);
    coingeckoVolume24hUsd = num(entry?.usd_24h_vol);
    if (coingeckoPriceUsd !== undefined && cgUrl) {
      coingeckoSource = { provider: "CoinGecko", url: cgUrl, fetchedAt: cg.fetchedAt };
    }
  }

  const result = computeConsistency({
    referencePriceUsd,
    llamaPriceUsd,
    llamaConfidence,
    coingeckoPriceUsd,
    marketCapUsd,
    coingeckoVolume24hUsd,
  });

  if (!result.aggregatorListed && !llamaSource && !coingeckoSource) {
    // Chain supported but the token isn't on either aggregator — that IS a
    // finding. Return a result (found:false) citing whichever URL we probed so
    // the "unlisted" flag has a re-checkable citation.
    const probe: Source = {
      provider: coingeckoSource ? "CoinGecko" : "DefiLlama",
      url: (cgUrl || llamaUrl)!,
      fetchedAt: new Date().toISOString(),
    };
    return { result, source: probe };
  }

  return {
    result,
    llamaSource,
    coingeckoSource,
    source: (coingeckoSource || llamaSource)!,
  };
}
