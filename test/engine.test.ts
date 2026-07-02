// Offline unit tests for the pure research logic — no network, no CROO keys.
// Run with:  npm test
//
// Zero-dependency harness on node:assert so the test run is reproducible for
// judges with nothing but `npm install`.

import assert from "node:assert/strict";
import { validateInput } from "../src/engine";
import {
  groupByToken,
  pickCanonicalToken,
  type DexPair,
} from "../src/engine/dexscreener";
import { assessRisk } from "../src/engine/risk";
import type { Resolution, Source } from "../src/engine/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

const SRC: Source = { provider: "test", url: "https://example.com", fetchedAt: "2026-01-01T00:00:00Z" };

const DAY = 86_400_000;

function pair(over: Partial<DexPair> & { addr?: string; liq?: number; ageDays?: number }): DexPair {
  const { addr = "0x" + "a".repeat(40), liq = 1_000_000, ageDays = 365, ...rest } = over;
  return {
    chainId: "ethereum",
    dexId: "uniswap",
    url: "https://dexscreener.com/ethereum/pair",
    pairAddress: "0x" + "b".repeat(40),
    baseToken: { address: addr, name: "Token", symbol: "TKN" },
    quoteToken: { address: "0x" + "c".repeat(40), name: "WETH", symbol: "WETH" },
    priceUsd: "1.0",
    liquidity: { usd: liq },
    volume: { h24: liq * 0.5 },
    pairCreatedAt: Date.now() - ageDays * DAY,
    ...rest,
  };
}

// ---------------------------------------------------------------- validateInput
console.log("validateInput");

test("accepts chain + token", () => {
  assert.deepEqual(validateInput({ chain: "base", token: "0xabc" }), { chain: "base", token: "0xabc" });
});

test("falls back to address / symbol keys", () => {
  assert.equal(validateInput({ chain: "base", address: "0xabc" }).token, "0xabc");
  assert.equal(validateInput({ chain: "base", symbol: "PEPE" }).token, "PEPE");
});

test("rejects missing chain", () => {
  assert.throws(() => validateInput({ token: "0xabc" }), /chain/i);
});

test("rejects missing token", () => {
  assert.throws(() => validateInput({ chain: "base" }), /token/i);
});

test("rejects non-object requirements", () => {
  assert.throws(() => validateInput("nope"), /JSON/i);
});

// --------------------------------------------------- canonical token resolution
console.log("pickCanonicalToken (impersonation resistance)");

test("spoofed single-pair whale liquidity loses to many-pair veteran", () => {
  // The exact live failure this guards against: an 0.8-day-old impersonator
  // reporting $485M "liquidity" vs canonical PEPE (many pairs, years old).
  const impersonator = pair({ addr: "0x" + "1".repeat(40), liq: 485_000_000, ageDays: 0.8 });
  const canonical = [
    pair({ addr: "0x" + "2".repeat(40), liq: 18_000_000, ageDays: 800 }),
    pair({ addr: "0x" + "2".repeat(40), liq: 5_000_000, ageDays: 700 }),
    pair({ addr: "0x" + "2".repeat(40), liq: 1_000_000, ageDays: 400 }),
  ];
  const chosen = pickCanonicalToken(groupByToken([impersonator, ...canonical]));
  assert.equal(chosen.address, "0x" + "2".repeat(40));
});

test("equal pair counts: older token wins", () => {
  const young = pair({ addr: "0x" + "3".repeat(40), liq: 9_000_000, ageDays: 2 });
  const old = pair({ addr: "0x" + "4".repeat(40), liq: 1_000_000, ageDays: 900 });
  const chosen = pickCanonicalToken(groupByToken([young, old]));
  assert.equal(chosen.address, "0x" + "4".repeat(40));
});

test("groupByToken aggregates liquidity, count, and oldest age", () => {
  const a1 = pair({ addr: "0x" + "5".repeat(40), liq: 100, ageDays: 10 });
  const a2 = pair({ addr: "0x" + "5".repeat(40), liq: 50, ageDays: 500 });
  const groups = groupByToken([a1, a2]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pairCount, 2);
  assert.equal(groups[0].totalLiquidityUsd, 150);
  assert.equal(groups[0].oldestPairCreatedAt, a2.pairCreatedAt);
});

// ------------------------------------------------------------------- assessRisk
console.log("assessRisk");

test("healthy deep old pair scores low", () => {
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, {
    result: { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0, simulationSuccess: true },
    source: SRC,
  });
  assert.equal(r.level, "low");
  assert.equal(r.flags[0].code, "NO_MAJOR_FLAGS");
});

test("honeypot detection is critical", () => {
  const r = assessRisk(pair({}), SRC, {
    result: { isHoneypot: true, simulationSuccess: true },
    source: SRC,
  });
  assert.ok(r.flags.some((f) => f.code === "HONEYPOT_DETECTED" && f.level === "critical"));
  assert.equal(r.level, "critical");
});

test("extreme sell tax is critical", () => {
  const r = assessRisk(pair({}), SRC, {
    result: { isHoneypot: false, buyTaxPct: 2, sellTaxPct: 45, simulationSuccess: true },
    source: SRC,
  });
  assert.ok(r.flags.some((f) => f.code === "TAX_EXTREME"));
});

test("failed simulation flags CONTRACT_UNVERIFIABLE", () => {
  const r = assessRisk(pair({}), SRC, {
    result: { isHoneypot: false, simulationSuccess: false },
    source: SRC,
  });
  assert.ok(r.flags.some((f) => f.code === "CONTRACT_UNVERIFIABLE"));
});

test("thin brand-new pair stacks liquidity + age flags", () => {
  const r = assessRisk(pair({ liq: 5_000, ageDays: 1, volume: { h24: 1_000 } }), SRC);
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes("LIQUIDITY_VERY_LOW"));
  assert.ok(codes.includes("PAIR_VERY_NEW"));
  assert.ok(r.score >= 70, `expected >=70, got ${r.score}`);
});

test("volume 20x liquidity flags wash trading", () => {
  const r = assessRisk(pair({ liq: 100_000, volume: { h24: 2_500_000 } }), SRC);
  assert.ok(r.flags.some((f) => f.code === "VOLUME_TURNOVER_EXTREME"));
});

test("FDV >100x liquidity flags exit mismatch", () => {
  const r = assessRisk(pair({ liq: 100_000, fdv: 50_000_000 }), SRC);
  assert.ok(r.flags.some((f) => f.code === "FDV_LIQUIDITY_MISMATCH"));
});

test("ambiguous symbol resolution is disclosed as a flag", () => {
  const resolution: Resolution = { method: "symbol-search", candidateTokens: 3, note: "" };
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, resolution);
  assert.ok(r.flags.some((f) => f.code === "SYMBOL_AMBIGUOUS" && f.level === "medium"));
});

test("address resolution adds no ambiguity flag", () => {
  const resolution: Resolution = { method: "address", candidateTokens: 1, note: "" };
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, resolution);
  assert.ok(!r.flags.some((f) => f.code === "SYMBOL_AMBIGUOUS"));
});

test("score is clamped to 100 and level thresholds hold", () => {
  const r = assessRisk(pair({ liq: 1_000, ageDays: 0.5, volume: { h24: 500_000 }, fdv: 900_000_000 }), SRC, {
    result: { isHoneypot: true, buyTaxPct: 50, sellTaxPct: 90, simulationSuccess: true },
    source: SRC,
  });
  assert.ok(r.score <= 100);
  assert.equal(r.level, "critical");
});

// ----------------------------------------------------------------------- result
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
