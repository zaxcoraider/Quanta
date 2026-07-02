// Orchestrates a full Token Due-Diligence report from a ResearchInput.
// Pure data-in / report-out — no CROO or network-key concerns here, so it can be
// unit-tested and run standalone via the CLI.

import { resolvePair } from "./dexscreener";
import { checkHoneypot } from "./honeypot";
import { assessRisk } from "./risk";
import { maybeSummarize } from "../llm";
import type { Cited, ResearchInput, Source, TokenReport } from "./types";

function cite<T>(value: T, source: Source): Cited<T> {
  return { value, source };
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

  // Contract-behavior check (EVM only). Uses the resolved on-chain address, not
  // the raw input, so symbol lookups are covered too. Null when unsupported/failed.
  const honeypot = await checkHoneypot(input.chain, pair.baseToken.address);

  const priceUsd = Number(pair.priceUsd ?? 0);
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;

  const { flags, score, level } = assessRisk(pair, source, honeypot, resolution);

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
    riskScore: score,
    riskLevel: level,
    flags,
    sources: dedupeSources([
      source,
      ...(honeypot ? [honeypot.source] : []),
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
