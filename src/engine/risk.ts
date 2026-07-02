// Deterministic risk heuristics derived purely from public market data.
// Each flag can carry the same Source used to derive it, so the buyer can audit
// the reasoning. These are intentionally transparent (no black box) — the value
// is verifiability, not a magic number.

import type { DexPair } from "./dexscreener";
import type { HoneypotResult } from "./honeypot";
import type { Resolution, RiskFlag, RiskLevel, Source } from "./types";

const LEVEL_WEIGHT: Record<RiskLevel, number> = {
  low: 10,
  medium: 25,
  high: 45,
  critical: 70,
};

export function assessRisk(
  pair: DexPair,
  source: Source,
  honeypot?: { result: HoneypotResult; source: Source } | null,
  resolution?: Resolution
): {
  flags: RiskFlag[];
  score: number;
  level: RiskLevel;
} {
  const flags: RiskFlag[] = [];

  // Resolution ambiguity: symbol input that matched several distinct contracts
  // means we may be looking at an impersonator despite canonical heuristics.
  if (resolution && resolution.method === "symbol-search" && resolution.candidateTokens > 1) {
    flags.push({
      code: "SYMBOL_AMBIGUOUS",
      level: "medium",
      message:
        `Input was a symbol that matched ${resolution.candidateTokens} distinct token contracts; ` +
        `canonical-token heuristics picked ${pair.baseToken.address}. Re-request by contract ` +
        `address to eliminate impersonation risk.`,
      source,
    });
  }

  const liq = pair.liquidity?.usd ?? 0;
  const vol = pair.volume?.h24 ?? 0;
  const fdv = pair.fdv ?? 0;
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : undefined;
  const ageDays = ageMs !== undefined ? ageMs / 86_400_000 : undefined;

  // Liquidity depth.
  if (liq < 10_000) {
    flags.push({
      code: "LIQUIDITY_VERY_LOW",
      level: "critical",
      message: `Liquidity is only $${Math.round(liq).toLocaleString()} — trivial to manipulate / rug.`,
      source,
    });
  } else if (liq < 50_000) {
    flags.push({
      code: "LIQUIDITY_LOW",
      level: "high",
      message: `Thin liquidity ($${Math.round(liq).toLocaleString()}); high slippage and manipulation risk.`,
      source,
    });
  }

  // Pair age.
  if (ageDays !== undefined && ageDays < 3) {
    flags.push({
      code: "PAIR_VERY_NEW",
      level: "high",
      message: `Pair is ${ageDays.toFixed(1)} days old — no track record, elevated rug risk.`,
      source,
    });
  } else if (ageDays !== undefined && ageDays < 30) {
    flags.push({
      code: "PAIR_NEW",
      level: "medium",
      message: `Pair is ${ageDays.toFixed(0)} days old — still early, treat with caution.`,
      source,
    });
  }

  // Volume vs liquidity (wash-trade / dead-pool signal).
  if (liq > 0) {
    const turnover = vol / liq;
    if (turnover > 20) {
      flags.push({
        code: "VOLUME_TURNOVER_EXTREME",
        level: "high",
        message: `24h volume is ${turnover.toFixed(1)}x liquidity — possible wash trading.`,
        source,
      });
    } else if (vol < liq * 0.02) {
      flags.push({
        code: "VOLUME_STAGNANT",
        level: "medium",
        message: `24h volume is <2% of liquidity — near-dead trading interest.`,
        source,
      });
    }
  }

  // FDV vs liquidity (valuation vs exit-ability).
  if (fdv > 0 && liq > 0 && fdv / liq > 100) {
    flags.push({
      code: "FDV_LIQUIDITY_MISMATCH",
      level: "medium",
      message: `FDV is ${Math.round(fdv / liq)}x liquidity — most supply cannot exit at quoted price.`,
      source,
    });
  }

  // Contract-behavior signals from the buy/sell simulation (EVM only).
  if (honeypot) {
    const hp = honeypot.result;
    const hpSource = honeypot.source;
    if (!hp.simulationSuccess) {
      flags.push({
        code: "CONTRACT_UNVERIFIABLE",
        level: "medium",
        message:
          "Buy/sell could not be simulated on-chain — sellability and taxes are unverifiable. Treat with caution.",
        source: hpSource,
      });
    } else {
      if (hp.isHoneypot) {
        flags.push({
          code: "HONEYPOT_DETECTED",
          level: "critical",
          message:
            "Sell simulation FAILED — tokens can be bought but not sold. Strong honeypot / scam signal.",
          source: hpSource,
        });
      }
      const sell = hp.sellTaxPct ?? 0;
      const buy = hp.buyTaxPct ?? 0;
      const worstTax = Math.max(sell, buy);
      if (worstTax >= 30) {
        flags.push({
          code: "TAX_EXTREME",
          level: "critical",
          message: `Trade tax up to ${worstTax.toFixed(1)}% (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%) — confiscatory.`,
          source: hpSource,
        });
      } else if (worstTax >= 10) {
        flags.push({
          code: "TAX_HIGH",
          level: "high",
          message: `Elevated trade tax (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%) erodes value on entry/exit.`,
          source: hpSource,
        });
      } else if (worstTax >= 5) {
        flags.push({
          code: "TAX_MODERATE",
          level: "medium",
          message: `Moderate trade tax (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%).`,
          source: hpSource,
        });
      }
    }
  }

  if (flags.length === 0) {
    flags.push({
      code: "NO_MAJOR_FLAGS",
      level: "low",
      message:
        honeypot?.result.simulationSuccess
          ? "No major red flags: market structure looks healthy and the buy/sell simulation passed with low tax. Not a guarantee of safety — holder concentration is not checked here."
          : "No major market-structure red flags from public DEX data. Not a guarantee of safety — verify contract & holders separately.",
      source,
    });
  }

  // Aggregate score: take the worst signal, add diminishing contributions.
  const sorted = [...flags].sort(
    (a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]
  );
  let score = 0;
  sorted.forEach((f, i) => {
    score += LEVEL_WEIGHT[f.level] / (i + 1);
  });
  score = Math.min(100, Math.round(score));

  const level: RiskLevel =
    score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";

  return { flags, score, level };
}
