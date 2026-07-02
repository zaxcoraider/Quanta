// Optional analyst-summary layer powered by Claude (claude-opus-4-8).
// This is a soft dependency: if @anthropic-ai/sdk isn't installed or
// ANTHROPIC_API_KEY isn't set, the agent still delivers the full deterministic,
// source-cited report — it just omits the prose summary. That keeps the core
// service key-free and always-runnable for the demo.

import type { TokenReport } from "./engine/types";

const MODEL = "claude-opus-4-8";

export async function maybeSummarize(
  report: Omit<TokenReport, "summary">
): Promise<string | undefined> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return undefined;

  let Anthropic: any;
  try {
    // Dynamic import so the package is truly optional.
    Anthropic = (await import("@anthropic-ai/sdk")).default;
  } catch {
    return undefined;
  }

  const client = new Anthropic({ apiKey: key });

  const facts = {
    token: `${report.resolved.name.value} (${report.resolved.symbol.value})`,
    chain: report.resolved.chain,
    priceUsd: report.market.priceUsd.value,
    liquidityUsd: report.market.liquidityUsd.value,
    volume24hUsd: report.market.volume24hUsd.value,
    riskScore: report.riskScore,
    riskLevel: report.riskLevel,
    flags: report.flags.map((f) => `[${f.level}] ${f.message}`),
  };

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      "You are a crypto due-diligence analyst. Write a concise, neutral 3-5 sentence " +
      "summary for a buyer. Only use the facts provided — never invent numbers. " +
      "Do not give financial advice; describe risk factually. End with one line on what " +
      "the buyer should independently verify next (contract source, holder concentration).",
    messages: [
      { role: "user", content: "Summarize this token report:\n" + JSON.stringify(facts, null, 2) },
    ],
  });

  const block = msg.content?.find((b: any) => b.type === "text");
  return block?.text?.trim();
}
