// Data source: GoPlus Labs Token Security API — free, no API key. It returns
// holder-distribution and contract-ownership facts that neither DexScreener
// (market structure) nor Honeypot.is (buy/sell behavior) provide: how
// concentrated the supply is among top holders, how much LP is locked, and
// whether the contract retains dangerous authorities (mintable, ownership
// take-back, hidden owner). This is the OWNERSHIP/DISTRIBUTION dimension of due
// diligence, and every claim stays citable to a re-fetchable URL.
//
// Docs: https://docs.gopluslabs.io/reference/token-security-api

import type { Source } from "./types";

const API = "https://api.gopluslabs.io/api/v1/token_security";

// GoPlus keys off numeric EVM chain IDs, same as Honeypot.is. Keep this map in
// sync with honeypot.ts. Anything not here (e.g. "solana") is skipped — GoPlus
// exposes non-EVM chains on separate endpoints with different shapes, so we
// degrade gracefully rather than guess.
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

export interface HoldersResult {
  /** Total number of holding addresses reported by GoPlus. */
  holderCount?: number;
  /**
   * Combined share (%) held by the top holders that are dumpable EOA wallets —
   * i.e. EXCLUDING addresses that are contracts (protocols, bridges, LP pools,
   * lockers) or flagged locked/burned. Contract-held supply is usually protocol
   * TVL rather than an insider who can rug, so counting it would false-flag blue
   * chips like WETH. This figure isolates the concentration that actually maps
   * to single-wallet dump risk. undefined when GoPlus returns no holder list.
   */
  topHolderConcentrationPct?: number;
  /** How many top-holder rows fed the concentration figure (for transparency). */
  topHoldersCounted?: number;
  /** How many of the returned top holders are contracts (excluded from concentration). */
  contractHoldersExcluded?: number;
  /** Share (%) of the LP that GoPlus marks as locked/burned. Higher = safer. */
  lpLockedPct?: number;
  /** Share (%) still held by the contract owner. */
  ownerPercentPct?: number;
  /** Share (%) still held by the contract creator. */
  creatorPercentPct?: number;
  /** Contract can mint new supply (dilution/inflation risk). undefined = unknown. */
  isMintable?: boolean;
  /** Ownership can be reclaimed after renouncement. undefined = unknown. */
  canTakeBackOwnership?: boolean;
  /** Contract hides a privileged owner. undefined = unknown. */
  hiddenOwner?: boolean;
  /** Source code is verified/open. undefined = unknown. */
  isOpenSource?: boolean;
  /** GoPlus actually returned data for this token. */
  found: boolean;
}

function now(): string {
  return new Date().toISOString();
}

/** Parse GoPlus tri-state boolean strings ("1"/"0"/"") into boolean | undefined. */
function flag(x: unknown): boolean | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  return String(x) === "1";
}

/** Parse a GoPlus fractional string (0..1) into a percentage, or undefined. */
function pct(x: unknown): number | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n * 100 : undefined;
}

function toInt(x: unknown): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// A holder row that is a contract, locked, burned, or a known null address is
// not a dumpable insider wallet — exclude it from concentration so we don't
// false-flag tokens whose supply sits in protocols, LP pools, lockers, or burn
// addresses (this is what makes blue chips like WETH read as concentrated).
function isNeutralized(row: any): boolean {
  if (Number(row?.is_contract) === 1) return true;
  if (Number(row?.is_locked) === 1) return true;
  const tag = String(row?.tag ?? "").toLowerCase();
  if (/burn|lock|null|dead/.test(tag)) return true;
  const addr = String(row?.address ?? "").toLowerCase();
  if (/^0x0{40}$/.test(addr) || /0*dead$/.test(addr)) return true;
  return false;
}

/**
 * Fetch holder-distribution & ownership facts for an EVM token. Returns null
 * (not an error) for non-EVM/unsupported chains or on upstream failure, so this
 * enrichment never blocks the overall report. On success returns the parsed
 * result plus the Source that backs it.
 */
export async function checkHolders(
  chain: string,
  address: string
): Promise<{ result: HoldersResult; source: Source } | null> {
  const chainId = CHAIN_ID[chain.toLowerCase()];
  if (!chainId) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;

  const apiUrl = `${API}/${chainId}?contract_addresses=${address}`;
  let data: any;
  try {
    const res = await fetch(apiUrl, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  // GoPlus keys the result object by the lower-cased address; take the first
  // (and only) entry rather than trusting our own casing.
  const entry: any = Object.values(data?.result ?? {})[0];
  const source: Source = {
    provider: "GoPlus Labs",
    // Human-viewable page that shows the same security breakdown, so a buyer
    // can independently confirm the holder/ownership figures we cite.
    url: `https://gopluslabs.io/token-security/${chainId}/${address}`,
    fetchedAt: now(),
  };

  if (!entry) {
    return { result: { found: false }, source };
  }

  return { result: parseHolders(entry), source };
}

/**
 * Pure transform from a single GoPlus token-security entry to HoldersResult.
 * Exported and network-free so the concentration/exclusion logic is unit-tested
 * directly against representative payloads.
 */
export function parseHolders(entry: any): HoldersResult {
  const holders: any[] = Array.isArray(entry?.holders) ? entry.holders : [];
  const counted = holders.filter((h) => !isNeutralized(h));
  const concentration = counted.reduce((sum, h) => sum + (pct(h.percent) ?? 0), 0);
  const contractHolders = holders.filter((h) => Number(h?.is_contract) === 1).length;

  const lp: any[] = Array.isArray(entry?.lp_holders) ? entry.lp_holders : [];
  const lpLocked = lp
    .filter((l) => Number(l?.is_locked) === 1 || /burn|lock|dead/.test(String(l?.tag ?? "").toLowerCase()))
    .reduce((sum, l) => sum + (pct(l.percent) ?? 0), 0);

  return {
    found: true,
    holderCount: toInt(entry?.holder_count),
    topHolderConcentrationPct: holders.length > 0 ? Math.round(concentration * 100) / 100 : undefined,
    topHoldersCounted: holders.length > 0 ? counted.length : undefined,
    contractHoldersExcluded: holders.length > 0 ? contractHolders : undefined,
    lpLockedPct: lp.length > 0 ? Math.round(lpLocked * 100) / 100 : undefined,
    ownerPercentPct: pct(entry?.owner_percent),
    creatorPercentPct: pct(entry?.creator_percent),
    isMintable: flag(entry?.is_mintable),
    canTakeBackOwnership: flag(entry?.can_take_back_ownership),
    hiddenOwner: flag(entry?.hidden_owner),
    isOpenSource: flag(entry?.is_open_source),
  };
}
