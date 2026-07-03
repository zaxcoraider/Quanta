// Human-readable rendering of a TokenReport. The JSON is the machine-verifiable
// deliverable; this Markdown brief is the "read it in five seconds" companion —
// verdict, per-dimension breakdown, grouped findings, and a numbered source list
// so every claim is still traceable. Pure (report in, string out), so it can be
// unit-tested and attached to a CAP delivery alongside the JSON.

import type { Cited, RiskFlag, RiskLevel, TokenReport } from "./types";

const LEVEL_EMOJI: Record<RiskLevel, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

const VERDICT: Record<RiskLevel, string> = {
  low: "LOW RISK",
  medium: "MODERATE RISK",
  high: "HIGH RISK",
  critical: "CRITICAL RISK",
};

// Severity order for grouping findings, worst first.
const LEVEL_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

function v<T>(c: Cited<T> | undefined): T | undefined {
  return c ? c.value : undefined;
}

// Force en-US grouping so output doesn't vary with the host machine's locale.
function commas(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1) return "$" + commas(Math.round(n));
  // Small prices: keep significant figures.
  return "$" + n.toPrecision(3);
}

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${n.toFixed(1)}%`;
}

function yesNo(b: boolean | undefined): string {
  return b === undefined ? "unknown" : b ? "yes" : "no";
}

function bool(c: Cited<boolean> | undefined): boolean | undefined {
  return c ? c.value : undefined;
}

/** Render a TokenReport as a self-contained Markdown brief. */
export function renderMarkdown(r: TokenReport): string {
  const out: string[] = [];
  const emoji = LEVEL_EMOJI[r.riskLevel];
  const sym = v(r.resolved.symbol) ?? "?";
  const name = v(r.resolved.name) ?? "Unknown";

  // ---- Header / verdict ------------------------------------------------------
  out.push(`# ${emoji} ${name} (${sym}) — ${VERDICT[r.riskLevel]}`);
  out.push("");
  out.push(
    `**Overall risk: ${r.riskScore}/100 (${r.riskLevel})** · ` +
      `confidence: **${r.confidence}** · chain: \`${r.resolved.chain}\``
  );
  out.push("");
  out.push(`\`${r.resolved.address}\``);
  out.push("");

  // Per-dimension breakdown.
  const s = r.scores;
  out.push("| Dimension | Score | Level |");
  out.push("| --- | --- | --- |");
  out.push(`| Market structure | ${s.market.score}/100 | ${LEVEL_EMOJI[s.market.level]} ${s.market.level} |`);
  out.push(`| Contract | ${s.contract.score}/100 | ${LEVEL_EMOJI[s.contract.level]} ${s.contract.level} |`);
  out.push(`| Holder distribution | ${s.holders.score}/100 | ${LEVEL_EMOJI[s.holders.level]} ${s.holders.level} |`);
  out.push("");
  out.push(`_${r.confidenceNote}_`);
  out.push("");

  // ---- Findings, grouped by severity ----------------------------------------
  const positives = r.flags.filter((f) => f.category === "positive");
  const risks = r.flags.filter((f) => f.category !== "positive" && f.code !== "NO_MAJOR_FLAGS");

  out.push("## Findings");
  out.push("");
  if (risks.length === 0) {
    out.push("No material risk findings from the resolved sources.");
    out.push("");
  } else {
    for (const level of LEVEL_ORDER) {
      const group = risks.filter((f) => f.level === level);
      if (group.length === 0) continue;
      out.push(`**${LEVEL_EMOJI[level]} ${level.toUpperCase()}**`);
      out.push("");
      for (const f of group) out.push(`- ${f.message} _(${f.category}, src #${sourceIndex(r, f)})_`);
      out.push("");
    }
  }
  if (positives.length > 0) {
    out.push("**✅ Positive signals**");
    out.push("");
    for (const f of positives) out.push(`- ${f.message}`);
    out.push("");
  }

  // ---- Key metrics -----------------------------------------------------------
  out.push("## Key metrics");
  out.push("");
  out.push(`- **Price:** ${usd(v(r.market.priceUsd))}`);
  out.push(`- **Liquidity:** ${usd(v(r.market.liquidityUsd))}`);
  out.push(`- **24h volume:** ${usd(v(r.market.volume24hUsd))}`);
  if (v(r.market.fdvUsd) !== undefined) out.push(`- **FDV:** ${usd(v(r.market.fdvUsd))}`);
  if (v(r.market.pairCreatedAt)) out.push(`- **Pair created:** ${v(r.market.pairCreatedAt)}`);
  if (r.holders?.holderCount) out.push(`- **Holders:** ${commas(v(r.holders.holderCount)!)}`);
  if (r.holders?.topHolderConcentrationPct !== undefined)
    out.push(`- **Top-holder concentration:** ${pct(v(r.holders.topHolderConcentrationPct))}`);
  out.push("");

  // ---- Contract / security capabilities (only if we have them) --------------
  if (r.contract || r.security) {
    out.push("## Contract & authorities");
    out.push("");
    if (r.contract) {
      out.push(`- **Honeypot (sell simulation):** ${yesNo(v(r.contract.isHoneypot))}`);
      if (v(r.contract.buyTaxPct) !== undefined || v(r.contract.sellTaxPct) !== undefined)
        out.push(`- **Taxes:** buy ${pct(v(r.contract.buyTaxPct))} / sell ${pct(v(r.contract.sellTaxPct))}`);
    }
    const line = (label: string, c: Cited<boolean> | undefined) => {
      if (c !== undefined) out.push(`- **${label}:** ${yesNo(bool(c))}`);
    };
    line("Mintable / mint authority", r.holders?.isMintable);
    if (r.security) {
      const sec = r.security;
      line("Ownership renounced", sec.ownershipRenounced);
      line("Freeze authority active", sec.freezeAuthorityActive);
      line("Can blacklist", sec.canBlacklist);
      line("Transfers pausable", sec.transferPausable);
      line("Owner can change balances", sec.ownerCanChangeBalance);
      line("Upgradeable proxy", sec.isProxy);
      line("Self-destructible", sec.selfdestruct);
      line("Non-transferable", sec.nonTransferable);
      line("Transfer hook", sec.transferHook);
    }
    out.push("");
  }

  // ---- Sources ---------------------------------------------------------------
  out.push("## Sources");
  out.push("");
  r.sources.forEach((src, i) => {
    out.push(`${i + 1}. **${src.provider}** — ${src.url} _(fetched ${src.fetchedAt})_`);
  });
  out.push("");

  if (r.upstream) {
    out.push(
      `> A2A annex: enriched by upstream agent \`${r.upstream.serviceId}\` ` +
        `(order \`${r.upstream.orderId}\`, contentHash \`${r.upstream.contentHash}\`).`
    );
    out.push("");
  }

  out.push(`_${r.contentNote}_`);
  out.push(`_Generated ${r.generatedAt}._`);

  return out.join("\n");
}

// Index (1-based) of a flag's source in the report's de-duped source list, for
// the "src #N" citations. Falls back to "?" when a flag carries no source.
function sourceIndex(r: TokenReport, f: RiskFlag): string {
  if (!f.source) return "?";
  const i = r.sources.findIndex((s) => s.provider === f.source!.provider && s.url === f.source!.url);
  return i >= 0 ? String(i + 1) : "?";
}
