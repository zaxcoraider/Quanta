// Deterministic risk heuristics derived purely from public, cited data.
// Each flag carries the Source used to derive it AND a category, so the buyer can
// audit both the reasoning and WHERE the risk sits (market / contract / holders).
// Intentionally transparent — the value is verifiability, not a magic number.

import type { DexPair } from "./dexscreener";
import type { HoneypotResult } from "./honeypot";
import type { HoldersResult } from "./holders";
import type {
  CategoryScore,
  Confidence,
  FlagCategory,
  Resolution,
  RiskFlag,
  RiskLevel,
  Source,
} from "./types";

const LEVEL_WEIGHT: Record<RiskLevel, number> = {
  low: 10,
  medium: 25,
  high: 45,
  critical: 70,
};

function levelFor(score: number): RiskLevel {
  return score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
}

// Worst signal dominates; additional signals add diminishing contributions.
// Positive (legitimacy) flags never raise a score.
function scoreOf(flags: RiskFlag[]): CategoryScore {
  const risk = flags.filter((f) => f.category !== "positive");
  if (risk.length === 0) return { score: 0, level: "low" };
  const sorted = [...risk].sort((a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]);
  let score = 0;
  sorted.forEach((f, i) => {
    score += LEVEL_WEIGHT[f.level] / (i + 1);
  });
  score = Math.min(100, Math.round(score));
  return { score, level: levelFor(score) };
}

export function assessRisk(
  pair: DexPair,
  source: Source,
  honeypot?: { result: HoneypotResult; source: Source } | null,
  resolution?: Resolution,
  holders?: { result: HoldersResult; source: Source } | null
): {
  flags: RiskFlag[];
  score: number;
  level: RiskLevel;
  scores: { market: CategoryScore; contract: CategoryScore; holders: CategoryScore };
  confidence: Confidence;
  confidenceNote: string;
} {
  const flags: RiskFlag[] = [];
  const add = (
    code: string,
    level: RiskLevel,
    category: FlagCategory,
    message: string,
    src: Source
  ) => flags.push({ code, level, category, message, source: src });

  // Resolution ambiguity: symbol input that matched several distinct contracts
  // means we may be looking at an impersonator despite canonical heuristics.
  if (resolution && resolution.method === "symbol-search" && resolution.candidateTokens > 1) {
    add(
      "SYMBOL_AMBIGUOUS",
      "medium",
      "resolution",
      `Input was a symbol that matched ${resolution.candidateTokens} distinct token contracts; ` +
        `canonical-token heuristics picked ${pair.baseToken.address}. Re-request by contract ` +
        `address to eliminate impersonation risk.`,
      source
    );
  }

  const liq = pair.liquidity?.usd ?? 0;
  const vol = pair.volume?.h24 ?? 0;
  const fdv = pair.fdv ?? 0;
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : undefined;
  const ageDays = ageMs !== undefined ? ageMs / 86_400_000 : undefined;

  // ---- Market structure ------------------------------------------------------
  if (liq < 10_000) {
    add("LIQUIDITY_VERY_LOW", "critical", "market", `Liquidity is only $${Math.round(liq).toLocaleString()} — trivial to manipulate / rug.`, source);
  } else if (liq < 50_000) {
    add("LIQUIDITY_LOW", "high", "market", `Thin liquidity ($${Math.round(liq).toLocaleString()}); high slippage and manipulation risk.`, source);
  }

  if (ageDays !== undefined && ageDays < 3) {
    add("PAIR_VERY_NEW", "high", "market", `Pair is ${ageDays.toFixed(1)} days old — no track record, elevated rug risk.`, source);
  } else if (ageDays !== undefined && ageDays < 30) {
    add("PAIR_NEW", "medium", "market", `Pair is ${ageDays.toFixed(0)} days old — still early, treat with caution.`, source);
  }

  if (liq > 0) {
    const turnover = vol / liq;
    if (turnover > 20) {
      add("VOLUME_TURNOVER_EXTREME", "high", "market", `24h volume is ${turnover.toFixed(1)}x liquidity — possible wash trading.`, source);
    } else if (vol < liq * 0.02) {
      add("VOLUME_STAGNANT", "medium", "market", `24h volume is <2% of liquidity — near-dead trading interest.`, source);
    }
  }

  if (fdv > 0 && liq > 0 && fdv / liq > 100) {
    add("FDV_LIQUIDITY_MISMATCH", "medium", "market", `FDV is ${Math.round(fdv / liq)}x liquidity — most supply cannot exit at quoted price.`, source);
  }

  // ---- Contract behavior (Honeypot.is on-chain simulation) -------------------
  if (honeypot) {
    const hp = honeypot.result;
    const s = honeypot.source;
    if (!hp.simulationSuccess) {
      add("CONTRACT_UNVERIFIABLE", "medium", "contract", "Buy/sell could not be simulated on-chain — sellability and taxes are unverifiable. Treat with caution.", s);
    } else {
      if (hp.isHoneypot) {
        add("HONEYPOT_DETECTED", "critical", "contract", "Sell simulation FAILED — tokens can be bought but not sold. Strong honeypot / scam signal.", s);
      }
      const sell = hp.sellTaxPct ?? 0;
      const buy = hp.buyTaxPct ?? 0;
      const worstTax = Math.max(sell, buy);
      if (worstTax >= 30) {
        add("TAX_EXTREME", "critical", "contract", `Trade tax up to ${worstTax.toFixed(1)}% (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%) — confiscatory.`, s);
      } else if (worstTax >= 10) {
        add("TAX_HIGH", "high", "contract", `Elevated trade tax (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%) erodes value on entry/exit.`, s);
      } else if (worstTax >= 5) {
        add("TAX_MODERATE", "medium", "contract", `Moderate trade tax (buy ${buy.toFixed(1)}% / sell ${sell.toFixed(1)}%).`, s);
      }
    }
  }

  // ---- Holder distribution + contract-capability surface (GoPlus) ------------
  if (holders && holders.result.found) {
    const h = holders.result;
    const s = holders.source;

    // Distribution → "holders" category.
    const conc = h.topHolderConcentrationPct;
    if (conc !== undefined) {
      if (conc >= 70) {
        add("HOLDER_CONCENTRATION_CRITICAL", "critical", "holders", `Top holders control ${conc.toFixed(1)}% of supply (dumpable non-contract wallets) — a handful of wallets can dump the token.`, s);
      } else if (conc >= 50) {
        add("HOLDER_CONCENTRATION_HIGH", "high", "holders", `Top holders control ${conc.toFixed(1)}% of supply (dumpable non-contract wallets) — heavily concentrated.`, s);
      } else if (conc >= 30) {
        add("HOLDER_CONCENTRATION_MODERATE", "medium", "holders", `Top holders control ${conc.toFixed(1)}% of supply (dumpable non-contract wallets) — moderate concentration.`, s);
      }
    }

    const ownerHold = Math.max(h.ownerPercentPct ?? 0, h.creatorPercentPct ?? 0);
    if (ownerHold >= 5) {
      add("OWNER_HOLDS_SUPPLY", ownerHold >= 20 ? "high" : "medium", "holders", `Owner/creator still holds ${ownerHold.toFixed(1)}% of supply — concentrated insider position.`, s);
    }

    // Contract-capability surface → "contract" category.
    if (h.isOpenSource === false) {
      add("CONTRACT_NOT_OPEN_SOURCE", "medium", "contract", "Contract source is unverified — behavior cannot be independently audited.", s);
    }
    if (h.hiddenOwner === true) {
      add("HIDDEN_OWNER", "high", "contract", "Contract hides a privileged owner — undisclosed control over the token.", s);
    }
    if (h.canTakeBackOwnership === true) {
      add("OWNERSHIP_TAKEBACK", "high", "contract", "Contract can reclaim ownership after renouncement — 'renounced' cannot be trusted.", s);
    }
    if (h.isProxy === true) {
      add("UPGRADEABLE_PROXY", "medium", "contract", "Upgradeable proxy — contract logic can be swapped, even after ownership is renounced.", s);
    }
    if (h.selfdestruct === true) {
      add("SELF_DESTRUCT", "critical", "contract", "Contract can self-destruct — the token can be destroyed outright.", s);
    }
    if (h.creatorPriorHoneypot === true) {
      add("CREATOR_PRIOR_HONEYPOT", "high", "contract", "Deployer previously created a known honeypot — serial-scammer signal.", s);
    }
    if (h.cannotBuy === true) {
      add("CANNOT_BUY", "high", "contract", "Token cannot currently be bought — trading is closed or gated.", s);
    }
    if (h.cannotSellAll === true) {
      add("CANNOT_SELL_ALL", "medium", "contract", "Holders cannot sell 100% of their position at once.", s);
    }
    if (h.tradingCooldown === true) {
      add("TRADING_COOLDOWN", "low", "contract", "Enforced cooldown between trades — sells can be delayed.", s);
    }
    if (h.externalCall === true) {
      add("EXTERNAL_CALLS", "low", "contract", "Contract makes external calls — added dependency/attack surface.", s);
    }
    // Cross-source honeypot catch: GoPlus flags one that the simulation missed.
    if (h.goplusIsHoneypot === true && honeypot?.result?.isHoneypot !== true) {
      add("GOPLUS_HONEYPOT", "critical", "contract", "GoPlus flags this token as a honeypot (unsellable) — corroborate before trading.", s);
    }

    // Owner-gated powers: only a live risk while an owner can actually use them.
    // A properly renounced token (e.g. PEPE) isn't penalised for dormant code.
    const ownerActive = h.ownershipRenounced !== true;
    if (ownerActive) {
      if (h.ownerCanChangeBalance === true) {
        add("OWNER_CAN_CHANGE_BALANCE", "critical", "contract", "Owner can arbitrarily rewrite balances — can zero out any holder.", s);
      }
      if (h.transferPausable === true) {
        add("PAUSABLE_TRANSFERS", "high", "contract", "Owner can pause all transfers — your position can be frozen.", s);
      }
      if (h.canBlacklist === true) {
        add("BLACKLIST_CAPABILITY", "high", "contract", "Owner can blacklist addresses — you can be blocked from selling.", s);
      }
      if (h.isWhitelisted === true) {
        add("WHITELIST_GATED", "medium", "contract", "Trading is whitelist-gated — only permitted addresses can trade.", s);
      }
      if (h.isMintable === true) {
        add("MINT_AUTHORITY_ENABLED", "medium", "contract", "Supply is mintable — holdings can be diluted by new issuance.", s);
      }
      if (h.slippageModifiable === true) {
        add("SLIPPAGE_MODIFIABLE", "medium", "contract", "Owner can change trading tax/slippage — taxes can be raised after you buy.", s);
      }
    }

    // Legitimacy signal (never raises a score, but surfaced prominently).
    if (h.cexListed === true) {
      const where = h.cexList && h.cexList.length > 0 ? h.cexList.join(", ") : "a centralized exchange";
      add("CEX_LISTED", "low", "positive", `Listed on ${where} — CEX listings undergo review, a strong legitimacy signal.`, s);
    }
  }

  // No risk findings at all (positive/legitimacy flags don't count).
  const hasRisk = flags.some((f) => f.category !== "positive");
  if (!hasRisk) {
    add(
      "NO_MAJOR_FLAGS",
      "low",
      "market",
      honeypot?.result.simulationSuccess
        ? "No major red flags: market structure looks healthy, the buy/sell simulation passed with low tax" +
            (holders?.result.found ? ", and holder distribution/contract capabilities carry no critical powers." : ". Holder/contract data was not available for this chain.")
        : "No major market-structure red flags from public DEX data. Not a guarantee of safety — verify contract & holders separately.",
      source
    );
  }

  // Overall (all risk flags) + per-category subscores.
  const overall = scoreOf(flags);
  const scores = {
    market: scoreOf(flags.filter((f) => f.category === "market")),
    contract: scoreOf(flags.filter((f) => f.category === "contract")),
    holders: scoreOf(flags.filter((f) => f.category === "holders")),
  };

  // Confidence = how many independent sources actually resolved usable data.
  const sourcesResolved =
    1 + // DexScreener market data (always present to reach here)
    (honeypot?.result.simulationSuccess ? 1 : 0) +
    (holders?.result.found ? 1 : 0);
  const confidence: Confidence = sourcesResolved >= 3 ? "high" : sourcesResolved === 2 ? "medium" : "low";
  const confidenceNote =
    confidence === "high"
      ? "All three sources resolved (market, on-chain simulation, holder/contract data)."
      : confidence === "medium"
        ? "Two of three sources resolved; one enrichment was unavailable (chain support or upstream)."
        : "Only market data resolved (e.g. non-EVM chain) — contract behavior and holder distribution are unverified here, so treat a low score cautiously.";

  return { flags, score: overall.score, level: overall.level, scores, confidence, confidenceNote };
}
