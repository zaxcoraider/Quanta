// Data source: GoPlus Labs *Solana* token-security API — free, no API key. EVM
// tokens are covered by honeypot.ts + holders.ts, but Solana has a different
// security model (SPL / Token-2022): the rug vectors are on-chain *authorities*
// (mint, freeze, balance-mutate) and Token-2022 extensions (non-transferable,
// transfer hooks, transfer fees) rather than Solidity owner functions.
//
// We normalise the response into the SAME HoldersResult shape used for EVM, so
// the report sections, risk flags, and scoring are reused. Solana mint authority
// maps onto `isMintable`, balance-mutate onto `ownerCanChangeBalance`, and the
// genuinely Solana-only concepts get their own fields.
//
// Docs: https://docs.gopluslabs.io/reference/solana-token-security-api

import { fetchJson } from "./http";
import type { HoldersResult } from "./holders";
import type { Source } from "./types";

const API = "https://api.gopluslabs.io/api/v1/solana/token_security";

// DexScreener slugs that mean Solana.
const SOLANA_CHAINS = new Set(["solana", "sol"]);

// Base58, 32–44 chars — a Solana mint address (deliberately excludes 0x… EVM).
function looksLikeSolanaMint(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

/** Read a GoPlus Solana authority object {authority:[], status:"0"|"1"}. */
function authActive(obj: any): boolean | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj.status === undefined || obj.status === null || obj.status === "") return undefined;
  return String(obj.status) === "1";
}

function boolish(x: unknown): boolean | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  return String(x) === "1";
}

function pct(x: unknown): number | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n * 100 : undefined;
}

function toInt(x: unknown): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// A Solana holder is excluded from concentration if locked or tagged (CEX /
// known program). Solana has no is_contract flag, so AMM pool vaults may still
// slip in — the flag message discloses that.
function isNeutralized(row: any): boolean {
  if (Number(row?.is_locked) === 1) return true;
  const tag = String(row?.tag ?? "").toLowerCase();
  if (tag && /burn|lock|null|dead|pool|amm|vault|raydium|orca/.test(tag)) return true;
  return false;
}

/**
 * Pure transform from a GoPlus Solana token-security entry to HoldersResult.
 * Exported and network-free so it can be unit-tested against captured payloads.
 */
export function parseSolanaSecurity(entry: any): HoldersResult {
  const holders: any[] = Array.isArray(entry?.holders) ? entry.holders : [];
  const counted = holders.filter((h) => !isNeutralized(h));
  const concentration = counted.reduce((sum, h) => sum + (pct(h.percent) ?? 0), 0);

  const meta = entry?.metadata_mutable;
  const metadataMutable = authActive(meta);
  const metadataMaliciousAuthority = Array.isArray(meta?.metadata_upgrade_authority)
    ? meta.metadata_upgrade_authority.some((a: any) => Number(a?.malicious_address) === 1)
    : undefined;

  const hook = entry?.transfer_hook;
  const fee = entry?.transfer_fee;

  return {
    found: true,
    holderCount: toInt(entry?.holder_count),
    topHolderConcentrationPct: holders.length > 0 ? Math.round(concentration * 100) / 100 : undefined,
    topHoldersCounted: holders.length > 0 ? counted.length : undefined,

    // Map Solana authorities onto the shared fields where semantics match.
    isMintable: authActive(entry?.mintable),
    ownerCanChangeBalance: authActive(entry?.balance_mutable_authority),

    // Solana-specific.
    freezeAuthorityActive: authActive(entry?.freezable),
    nonTransferable: boolish(entry?.non_transferable),
    transferHook: Array.isArray(hook) ? hook.length > 0 : boolish(hook),
    transferFee: fee && typeof fee === "object" ? Object.keys(fee).length > 0 : boolish(fee),
    metadataMutable,
    metadataMaliciousAuthority,
    trustedToken: boolish(entry?.trusted_token),
  };
}

/**
 * Fetch Solana token security. Returns null (not an error) for non-Solana chains,
 * non-mint inputs, or upstream failure, so it never blocks the report. On success
 * returns a normalised HoldersResult plus the Source that backs it.
 */
export async function checkSolanaSecurity(
  chain: string,
  address: string
): Promise<{ result: HoldersResult; source: Source } | null> {
  if (!SOLANA_CHAINS.has(chain.toLowerCase())) return null;
  if (!looksLikeSolanaMint(address)) return null;

  const apiUrl = `${API}?contract_addresses=${address}`;
  let data: any;
  let fetchedAt: string;
  try {
    const res = await fetchJson<any>(apiUrl, { retries: 1 });
    data = res.data;
    fetchedAt = res.fetchedAt;
  } catch {
    return null;
  }

  const entry: any = Object.values(data?.result ?? {})[0];
  const source: Source = {
    provider: "GoPlus Labs",
    // Re-fetchable Solana security endpoint — a buyer (human or agent) can pull
    // the same JSON to confirm every authority/holder figure we cite.
    url: apiUrl,
    fetchedAt,
  };

  if (!entry) return { result: { found: false }, source };
  return { result: parseSolanaSecurity(entry), source };
}
