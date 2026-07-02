// Data source: honeypot.is public API — free, no API key. It runs an on-chain
// simulation of a buy followed by a sell for an EVM token and reports whether the
// token is a honeypot (unsellable) plus the actual buy/sell/transfer taxes. This
// is contract-BEHAVIOR verification, complementing the market-structure signals we
// get from DexScreener, and every claim stays citable to a re-fetchable URL.
//
// Docs: https://docs.honeypot.is/  (v2 endpoint used below)

import type { Source } from "./types";

const API = "https://api.honeypot.is/v2/IsHoneypot";

// honeypot.is keys off numeric EVM chain IDs. Map the DexScreener chain slugs we
// support; anything not here (e.g. "solana") is simply skipped — non-EVM tokens
// can't be simulated this way, so we degrade gracefully rather than error.
const CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  base: 8453,
  bsc: 56,
  binance: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  avalanche: 43114,
  avax: 43114,
};

export interface HoneypotResult {
  /** True if the sell simulation failed — funds go in but cannot come out. */
  isHoneypot: boolean;
  /** Buy tax as a percentage (e.g. 5 = 5%). Undefined if simulation failed. */
  buyTaxPct?: number;
  sellTaxPct?: number;
  transferTaxPct?: number;
  /** Whether honeypot.is could actually simulate the trade at all. */
  simulationSuccess: boolean;
  /** honeypot.is's own summary risk label, if provided. */
  riskLabel?: string;
}

function now(): string {
  return new Date().toISOString();
}

function num(x: unknown): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Run a honeypot/tax check for an EVM token address. Returns null (not an error)
 * when the chain is non-EVM/unsupported or when the upstream call fails, so the
 * overall report is never blocked by this optional enrichment. When it succeeds it
 * returns the result plus the Source that backs it.
 */
export async function checkHoneypot(
  chain: string,
  address: string
): Promise<{ result: HoneypotResult; source: Source } | null> {
  const chainId = CHAIN_ID[chain.toLowerCase()];
  if (!chainId) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;

  const apiUrl = `${API}?address=${address}&chainID=${chainId}`;
  let data: any;
  try {
    const res = await fetch(apiUrl, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const simulationSuccess = Boolean(data?.simulationSuccess);
  const sim = data?.simulationResult ?? {};

  const result: HoneypotResult = {
    isHoneypot: Boolean(data?.honeypotResult?.isHoneypot),
    buyTaxPct: num(sim.buyTax),
    sellTaxPct: num(sim.sellTax),
    transferTaxPct: num(sim.transferTax),
    simulationSuccess,
    riskLabel: data?.summary?.risk,
  };

  return {
    result,
    source: {
      provider: "Honeypot.is",
      // Human-viewable page that re-runs the same simulation, so a buyer can
      // independently confirm the honeypot/tax numbers we cite.
      url: `https://honeypot.is/?address=${address}&chain=${chain.toLowerCase()}`,
      fetchedAt: now(),
    },
  };
}
