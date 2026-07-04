// Optional analyst-intelligence overlay powered by a top LLM via dgrid
// (OpenAI-compatible: one key, any model — Opus 4.8 by default).
//
// This is a SOFT, clearly-labeled LAYER on top of the verifiable core: it
// SYNTHESISES and REASONS about facts that were already verified and
// source-cited by the deterministic engine — it never produces or alters a
// number. Design guarantees that keep Quanta's verifiability USP intact:
//   - Grounding: the model is given ONLY the structured facts and is
//     instructed to use nothing else and invent no numbers.
//   - Separation: this text is delivered as a labeled advisory field and is
//     EXCLUDED from the on-chain-hashed deliverable core, so `npm run verify`
//     still proves the facts regardless of what the model says.
//   - Optional: with no key set, the agent still delivers the full
//     deterministic, cited report; the overlay is simply omitted.

import type { TokenReport } from "./engine/types";

const DEFAULT_BASE = "https://api.dgrid.ai/v1";
const DEFAULT_MODEL = "claude-opus-4-8";

const SYSTEM =
  "You are a professional crypto due-diligence analyst. You are given the " +
  "VERIFIED, source-cited findings of a deterministic analysis engine. Write a " +
  "concise, neutral analyst brief (4-7 sentences) for a buyer that SYNTHESISES " +
  "these findings and explains HOW the individual risk flags combine into the " +
  "overall verdict. Rules: use ONLY the facts provided — never invent, estimate, " +
  "or alter any number; if a fact is absent, say it is unavailable rather than " +
  "guessing. Do not give financial or investment advice; describe risk factually. " +
  "End with one short line naming what the buyer should independently verify next " +
  "(e.g. contract source, holder concentration, LP lock).";

/** Only the fields the model is allowed to reason over. Keeps grounding tight. */
export interface AnalystFacts {
  token: string;
  chain: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  riskScore: number;
  riskLevel: string;
  confidence: string;
  scores: TokenReport["scores"];
  flags: string[];
}

/** Extract the grounding facts from a report — nothing else reaches the model. */
export function buildAnalystFacts(report: Omit<TokenReport, "summary">): AnalystFacts {
  return {
    token: `${report.resolved.name.value} (${report.resolved.symbol.value})`,
    chain: report.resolved.chain,
    priceUsd: report.market.priceUsd?.value ?? null,
    liquidityUsd: report.market.liquidityUsd?.value ?? null,
    volume24hUsd: report.market.volume24hUsd?.value ?? null,
    riskScore: report.riskScore,
    riskLevel: report.riskLevel,
    confidence: report.confidence,
    scores: report.scores,
    flags: report.flags.map((f) => `[${f.level}/${f.category}] ${f.message}`),
  };
}

export interface LlmOptions {
  /** Injectable fetch, for offline tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Produce the labeled AI analyst brief, or undefined if disabled/unavailable.
 * Never throws — any failure (no key, network, non-200, bad body) degrades to
 * undefined so the deterministic report always ships.
 */
export async function maybeSummarize(
  report: Omit<TokenReport, "summary">,
  opts: LlmOptions = {}
): Promise<string | undefined> {
  const key = process.env.DGRID_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return undefined;

  const baseURL = (process.env.DGRID_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
  const model = process.env.QUANTA_LLM_MODEL || DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const facts = buildAnalystFacts(report);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await doFetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "Analyse this token due-diligence data:\n" + JSON.stringify(facts, null, 2) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
