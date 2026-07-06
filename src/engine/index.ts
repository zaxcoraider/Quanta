// Orchestrates a full Token Due-Diligence report from a ResearchInput.
// Pure data-in / report-out — no CROO or network-key concerns here, so it can be
// unit-tested and run standalone via the CLI.

import { resolvePair } from "./dexscreener";
import { checkHoneypot } from "./honeypot";
import { checkHolders } from "./holders";
import { checkSolanaSecurity } from "./solana";
import { checkConsistency } from "./consistency";
import { assessRisk } from "./risk";
import { maybeSummarize } from "../llm";
import type { Cited, ResearchInput, Source, TokenReport } from "./types";

function cite<T>(value: T, source: Source): Cited<T> {
  return { value, source };
}

/** cite() a value only when it's defined, else omit the field entirely. */
function citeOpt<T>(value: T | undefined, source: Source): Cited<T> | undefined {
  return value !== undefined ? cite(value, source) : undefined;
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    const k = `${s.provider}|${s.url}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

export function validateInput(raw: any): ResearchInput {
  if (!raw || typeof raw !== "object") {
    throw new Error('Requirements must be JSON like {"chain":"base","token":"0x..."}');
  }
  const chain = String(raw.chain ?? "").trim();
  const token = String(raw.token ?? raw.address ?? raw.symbol ?? "").trim();
  if (!chain) throw new Error('Missing "chain" (e.g. "ethereum", "base", "bsc", "solana").');
  if (!token) throw new Error('Missing "token" (contract address or symbol).');
  return { chain, token };
}

export async function runResearch(input: ResearchInput): Promise<TokenReport> {
  const { pair, source, resolution } = await resolvePair(input.chain, input.token);

  // Enrichment checks. All use the resolved on-chain address (so symbol lookups
  // are covered) and all return null on unsupported chains / upstream failure, so
  // none blocks the report. Run concurrently — independent APIs.
  //  - Honeypot.is: EVM buy/sell simulation (contract behavior).
  //  - GoPlus EVM: holder distribution + Solidity capability surface.
  //  - GoPlus Solana: holder distribution + SPL/Token-2022 authorities.
  // EVM and Solana GoPlus are mutually exclusive by chain; `holders` is whichever
  // resolved, normalised to one shape so the report/scoring are shared.
  const priceUsd = Number(pair.priceUsd ?? 0);
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;

  const [honeypot, evmHolders, solHolders, consistency] = await Promise.all([
    checkHoneypot(input.chain, pair.baseToken.address),
    checkHolders(input.chain, pair.baseToken.address),
    checkSolanaSecurity(input.chain, pair.baseToken.address),
    // Cross-source price audit — uses the resolved address + DexScreener price.
    checkConsistency(input.chain, pair.baseToken.address, priceUsd),
  ]);
  const holders = evmHolders ?? solHolders;

  const { flags, score, level, scores, confidence, confidenceNote } = assessRisk(
    pair,
    source,
    honeypot,
    resolution,
    holders,
    consistency
  );

  const base: Omit<TokenReport, "summary"> = {
    schemaVersion: "1.0",
    input,
    resolved: {
      name: cite(pair.baseToken.name, source),
      symbol: cite(pair.baseToken.symbol, source),
      address: pair.baseToken.address,
      chain: pair.chainId,
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
    },
    resolution,
    market: {
      priceUsd: cite(priceUsd, source),
      fdvUsd: pair.fdv !== undefined ? cite(pair.fdv, source) : undefined,
      liquidityUsd: cite(liquidityUsd, source),
      volume24hUsd: cite(volume24hUsd, source),
      priceChange24hPct:
        pair.priceChange?.h24 !== undefined ? cite(pair.priceChange.h24, source) : undefined,
      pairCreatedAt: pair.pairCreatedAt
        ? cite(new Date(pair.pairCreatedAt).toISOString(), source)
        : undefined,
    },
    contract: honeypot
      ? {
          isHoneypot: cite(honeypot.result.isHoneypot, honeypot.source),
          buyTaxPct:
            honeypot.result.buyTaxPct !== undefined
              ? cite(honeypot.result.buyTaxPct, honeypot.source)
              : undefined,
          sellTaxPct:
            honeypot.result.sellTaxPct !== undefined
              ? cite(honeypot.result.sellTaxPct, honeypot.source)
              : undefined,
          transferTaxPct:
            honeypot.result.transferTaxPct !== undefined
              ? cite(honeypot.result.transferTaxPct, honeypot.source)
              : undefined,
          simulationSuccess: cite(honeypot.result.simulationSuccess, honeypot.source),
        }
      : undefined,
    holders:
      holders && holders.result.found
        ? {
            holderCount:
              holders.result.holderCount !== undefined
                ? cite(holders.result.holderCount, holders.source)
                : undefined,
            topHolderConcentrationPct:
              holders.result.topHolderConcentrationPct !== undefined
                ? cite(holders.result.topHolderConcentrationPct, holders.source)
                : undefined,
            lpLockedPct:
              holders.result.lpLockedPct !== undefined
                ? cite(holders.result.lpLockedPct, holders.source)
                : undefined,
            ownerPercentPct:
              holders.result.ownerPercentPct !== undefined
                ? cite(holders.result.ownerPercentPct, holders.source)
                : undefined,
            creatorPercentPct:
              holders.result.creatorPercentPct !== undefined
                ? cite(holders.result.creatorPercentPct, holders.source)
                : undefined,
            isMintable:
              holders.result.isMintable !== undefined
                ? cite(holders.result.isMintable, holders.source)
                : undefined,
            canTakeBackOwnership:
              holders.result.canTakeBackOwnership !== undefined
                ? cite(holders.result.canTakeBackOwnership, holders.source)
                : undefined,
            hiddenOwner:
              holders.result.hiddenOwner !== undefined
                ? cite(holders.result.hiddenOwner, holders.source)
                : undefined,
            isOpenSource:
              holders.result.isOpenSource !== undefined
                ? cite(holders.result.isOpenSource, holders.source)
                : undefined,
          }
        : undefined,
    security:
      holders && holders.result.found
        ? {
            ownershipRenounced: citeOpt(holders.result.ownershipRenounced, holders.source),
            isProxy: citeOpt(holders.result.isProxy, holders.source),
            selfdestruct: citeOpt(holders.result.selfdestruct, holders.source),
            externalCall: citeOpt(holders.result.externalCall, holders.source),
            transferPausable: citeOpt(holders.result.transferPausable, holders.source),
            canBlacklist: citeOpt(holders.result.canBlacklist, holders.source),
            isWhitelisted: citeOpt(holders.result.isWhitelisted, holders.source),
            ownerCanChangeBalance: citeOpt(holders.result.ownerCanChangeBalance, holders.source),
            slippageModifiable: citeOpt(holders.result.slippageModifiable, holders.source),
            tradingCooldown: citeOpt(holders.result.tradingCooldown, holders.source),
            cannotSellAll: citeOpt(holders.result.cannotSellAll, holders.source),
            cannotBuy: citeOpt(holders.result.cannotBuy, holders.source),
            creatorPriorHoneypot: citeOpt(holders.result.creatorPriorHoneypot, holders.source),
            goplusIsHoneypot: citeOpt(holders.result.goplusIsHoneypot, holders.source),
            cexListed: citeOpt(holders.result.cexListed, holders.source),
            cexList: citeOpt(holders.result.cexList, holders.source),
            freezeAuthorityActive: citeOpt(holders.result.freezeAuthorityActive, holders.source),
            nonTransferable: citeOpt(holders.result.nonTransferable, holders.source),
            transferHook: citeOpt(holders.result.transferHook, holders.source),
            transferFee: citeOpt(holders.result.transferFee, holders.source),
            metadataMutable: citeOpt(holders.result.metadataMutable, holders.source),
            metadataMaliciousAuthority: citeOpt(holders.result.metadataMaliciousAuthority, holders.source),
            trustedToken: citeOpt(holders.result.trustedToken, holders.source),
          }
        : undefined,
    consistency: consistency
      ? {
          referencePriceUsd: citeOpt(consistency.result.referencePriceUsd, source),
          llamaPriceUsd:
            consistency.llamaSource !== undefined
              ? citeOpt(consistency.result.llamaPriceUsd, consistency.llamaSource)
              : undefined,
          llamaConfidence:
            consistency.llamaSource !== undefined
              ? citeOpt(consistency.result.llamaConfidence, consistency.llamaSource)
              : undefined,
          coingeckoPriceUsd:
            consistency.coingeckoSource !== undefined
              ? citeOpt(consistency.result.coingeckoPriceUsd, consistency.coingeckoSource)
              : undefined,
          marketCapUsd:
            consistency.coingeckoSource !== undefined
              ? citeOpt(consistency.result.marketCapUsd, consistency.coingeckoSource)
              : undefined,
          coingeckoVolume24hUsd:
            consistency.coingeckoSource !== undefined
              ? citeOpt(consistency.result.coingeckoVolume24hUsd, consistency.coingeckoSource)
              : undefined,
          pricedSources: consistency.result.pricedSources,
          maxDivergencePct: citeOpt(consistency.result.maxDivergencePct, consistency.source),
          aggregatorListed: consistency.result.aggregatorListed,
        }
      : undefined,
    riskScore: score,
    riskLevel: level,
    scores,
    confidence,
    confidenceNote,
    flags,
    sources: dedupeSources([
      source,
      ...(honeypot ? [honeypot.source] : []),
      ...(holders && holders.result.found ? [holders.source] : []),
      ...(consistency?.llamaSource ? [consistency.llamaSource] : []),
      ...(consistency?.coingeckoSource ? [consistency.coingeckoSource] : []),
      ...(flags.map((f) => f.source).filter(Boolean) as Source[]),
    ]),
    generatedAt: new Date().toISOString(),
    contentNote:
      "All figures sourced from public DEX data at generatedAt; a keccak256 hash of this " +
      "deliverable is committed on-chain by CAP at settlement for tamper-evidence.",
  };

  const summary = await maybeSummarize(base);
  return summary ? { ...base, summary } : base;
}
