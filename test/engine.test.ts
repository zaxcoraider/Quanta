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
import { parseHolders, type HoldersResult } from "../src/engine/holders";
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

// ------------------------------------------------- parseHolders (GoPlus mapping)
console.log("parseHolders (holder-distribution mapping)");

// A GoPlus-shaped holder row. GoPlus reports percent as a 0..1 fraction string.
function holder(over: { pct: number; contract?: boolean; locked?: boolean; tag?: string; address?: string }) {
  return {
    address: over.address ?? "0x" + "e".repeat(40),
    tag: over.tag ?? "",
    is_contract: over.contract ? 1 : 0,
    is_locked: over.locked ? 1 : 0,
    percent: String(over.pct),
  };
}

test("concentration counts only dumpable EOA holders", () => {
  // 20% EOA + 60% contract + 5% locked → only the 20% EOA is dumpable.
  const r = parseHolders({
    holder_count: "1000",
    holders: [
      holder({ pct: 0.2 }),
      holder({ pct: 0.6, contract: true }),
      holder({ pct: 0.05, locked: true }),
    ],
    is_open_source: "1",
  });
  assert.equal(r.topHolderConcentrationPct, 20);
  assert.equal(r.contractHoldersExcluded, 1);
  assert.equal(r.topHoldersCounted, 1);
});

test("blue-chip shape (all top holders are contracts) reads as 0% concentration", () => {
  const r = parseHolders({
    holders: [holder({ pct: 0.3, contract: true }), holder({ pct: 0.25, contract: true })],
  });
  assert.equal(r.topHolderConcentrationPct, 0);
});

test("burn/dead/null addresses are excluded from concentration", () => {
  const r = parseHolders({
    holders: [
      holder({ pct: 0.4, address: "0x000000000000000000000000000000000000dead" }),
      holder({ pct: 0.1, tag: "Null Address" }),
      holder({ pct: 0.15 }),
    ],
  });
  assert.equal(r.topHolderConcentrationPct, 15);
});

test("tri-state authority flags parse 1/0/empty into true/false/undefined", () => {
  const r = parseHolders({
    holders: [],
    is_mintable: "1",
    can_take_back_ownership: "0",
    hidden_owner: "",
    owner_percent: "0.12",
  });
  assert.equal(r.isMintable, true);
  assert.equal(r.canTakeBackOwnership, false);
  assert.equal(r.hiddenOwner, undefined);
  assert.equal(r.ownerPercentPct, 12);
  // No holders array → concentration undefined, not 0.
  assert.equal(r.topHolderConcentrationPct, undefined);
});

// ------------------------------------------------------ assessRisk (holder flags)
console.log("assessRisk (holder-distribution signals)");

function holders(over: Partial<HoldersResult>): { result: HoldersResult; source: Source } {
  return { result: { found: true, ...over }, source: SRC };
}

test("critical EOA concentration is flagged critical", () => {
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, undefined, holders({ topHolderConcentrationPct: 75 }));
  assert.ok(r.flags.some((f) => f.code === "HOLDER_CONCENTRATION_CRITICAL" && f.level === "critical"));
});

test("high concentration flagged high, moderate flagged medium", () => {
  const hi = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, undefined, holders({ topHolderConcentrationPct: 55 }));
  assert.ok(hi.flags.some((f) => f.code === "HOLDER_CONCENTRATION_HIGH" && f.level === "high"));
  const mod = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, undefined, holders({ topHolderConcentrationPct: 35 }));
  assert.ok(mod.flags.some((f) => f.code === "HOLDER_CONCENTRATION_MODERATE" && f.level === "medium"));
});

test("healthy distribution adds no concentration flag", () => {
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, {
    result: { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0, simulationSuccess: true },
    source: SRC,
  }, undefined, holders({ topHolderConcentrationPct: 12, isOpenSource: true }));
  assert.ok(!r.flags.some((f) => f.code.startsWith("HOLDER_CONCENTRATION")));
  assert.equal(r.level, "low");
});

test("retained authorities and owner holdings are flagged", () => {
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, undefined, holders({
    topHolderConcentrationPct: 5,
    ownerPercentPct: 25,
    canTakeBackOwnership: true,
    hiddenOwner: true,
    isMintable: true,
    isOpenSource: false,
  }));
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes("OWNER_HOLDS_SUPPLY"));
  assert.ok(r.flags.some((f) => f.code === "OWNER_HOLDS_SUPPLY" && f.level === "high")); // >=20 → high
  assert.ok(codes.includes("OWNERSHIP_TAKEBACK"));
  assert.ok(codes.includes("HIDDEN_OWNER"));
  assert.ok(codes.includes("MINT_AUTHORITY_ENABLED"));
  assert.ok(codes.includes("CONTRACT_NOT_OPEN_SOURCE"));
});

test("holders unavailable (null) adds no holder flags and cannot crash", () => {
  const r = assessRisk(pair({ liq: 50_000_000, ageDays: 900 }), SRC, null, undefined, null);
  assert.ok(!r.flags.some((f) => f.code.startsWith("HOLDER_") || f.code === "OWNERSHIP_TAKEBACK"));
});

test("ownership renouncement derivation (parseHolders)", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  assert.equal(parseHolders({ holders: [], owner_address: zero, can_take_back_ownership: "0", hidden_owner: "0" }).ownershipRenounced, true);
  assert.equal(parseHolders({ holders: [], owner_address: "0x" + "a".repeat(40) }).ownershipRenounced, false);
  assert.equal(parseHolders({ holders: [], owner_address: zero, can_take_back_ownership: "1" }).ownershipRenounced, false);
  assert.equal(parseHolders({ holders: [] }).ownershipRenounced, undefined); // no owner_address
});

test("CEX listing + capability booleans parse (parseHolders)", () => {
  const r = parseHolders({
    holders: [],
    is_in_cex: { listed: "1", cex_list: ["Binance", "Coinbase"] },
    selfdestruct: "1",
    is_proxy: "0",
    transfer_pausable: "1",
    honeypot_with_same_creator: "1",
  });
  assert.equal(r.cexListed, true);
  assert.deepEqual(r.cexList, ["Binance", "Coinbase"]);
  assert.equal(r.selfdestruct, true);
  assert.equal(r.isProxy, false);
  assert.equal(r.transferPausable, true);
  assert.equal(r.creatorPriorHoneypot, true);
});

// ------------------------------------------------- assessRisk (contract capability)
console.log("assessRisk (contract-capability signals)");

const HEALTHY = () => pair({ liq: 50_000_000, ageDays: 900 });

test("owner-gated powers are suppressed when ownership is renounced", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({
    ownershipRenounced: true,
    canBlacklist: true,
    transferPausable: true,
    isMintable: true,
    ownerCanChangeBalance: true,
  }));
  const codes = r.flags.map((f) => f.code);
  assert.ok(!codes.includes("BLACKLIST_CAPABILITY"));
  assert.ok(!codes.includes("PAUSABLE_TRANSFERS"));
  assert.ok(!codes.includes("MINT_AUTHORITY_ENABLED"));
  assert.ok(!codes.includes("OWNER_CAN_CHANGE_BALANCE"));
});

test("owner-gated powers fire when ownership is NOT renounced", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({
    ownershipRenounced: false,
    canBlacklist: true,
    ownerCanChangeBalance: true,
  }));
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes("BLACKLIST_CAPABILITY"));
  assert.ok(r.flags.some((f) => f.code === "OWNER_CAN_CHANGE_BALANCE" && f.level === "critical"));
});

test("unknown renouncement is treated conservatively (powers fire)", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({ canBlacklist: true })); // renounced undefined
  assert.ok(r.flags.some((f) => f.code === "BLACKLIST_CAPABILITY"));
});

test("always-on powers fire regardless of renouncement", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({
    ownershipRenounced: true,
    selfdestruct: true,
    creatorPriorHoneypot: true,
  }));
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes("SELF_DESTRUCT"));
  assert.ok(codes.includes("CREATOR_PRIOR_HONEYPOT"));
});

test("GoPlus honeypot fires as cross-source catch, but not when Honeypot.is already flagged it", () => {
  const solo = assessRisk(HEALTHY(), SRC, null, undefined, holders({ goplusIsHoneypot: true }));
  assert.ok(solo.flags.some((f) => f.code === "GOPLUS_HONEYPOT"));
  const dup = assessRisk(HEALTHY(), SRC, { result: { isHoneypot: true, simulationSuccess: true }, source: SRC }, undefined, holders({ goplusIsHoneypot: true }));
  assert.ok(dup.flags.some((f) => f.code === "HONEYPOT_DETECTED"));
  assert.ok(!dup.flags.some((f) => f.code === "GOPLUS_HONEYPOT"));
});

test("CEX listing is a positive flag and never raises the score", () => {
  const r = assessRisk(HEALTHY(), SRC, { result: { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0, simulationSuccess: true }, source: SRC }, undefined, holders({ cexListed: true, cexList: ["Binance"] }));
  const cex = r.flags.find((f) => f.code === "CEX_LISTED");
  assert.ok(cex && cex.category === "positive");
  assert.equal(r.level, "low"); // positive flag doesn't push it up
  assert.equal(r.scores.contract.score, 0);
});

// ------------------------------------------------------ assessRisk (scores + confidence)
console.log("assessRisk (subscores + confidence)");

test("subscores isolate the offending dimension", () => {
  const r = assessRisk(HEALTHY(), SRC, { result: { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0, simulationSuccess: true }, source: SRC }, undefined, holders({ topHolderConcentrationPct: 75 }));
  assert.equal(r.scores.holders.level, "critical");
  assert.equal(r.scores.market.score, 0);
  assert.equal(r.scores.contract.score, 0);
});

test("confidence reflects how many sources resolved", () => {
  const hp = { result: { isHoneypot: false, simulationSuccess: true }, source: SRC };
  assert.equal(assessRisk(HEALTHY(), SRC, hp, undefined, holders({})).confidence, "high"); // 3 sources
  assert.equal(assessRisk(HEALTHY(), SRC, hp, undefined, null).confidence, "medium"); // 2 sources
  assert.equal(assessRisk(HEALTHY(), SRC, null, undefined, null).confidence, "low"); // market only
  // A failed simulation does not count toward confidence.
  assert.equal(assessRisk(HEALTHY(), SRC, { result: { isHoneypot: false, simulationSuccess: false }, source: SRC }, undefined, null).confidence, "low");
});

// ----------------------------------------------------------------------- result
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
