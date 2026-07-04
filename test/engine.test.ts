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
import { parseSolanaSecurity } from "../src/engine/solana";
import { renderMarkdown } from "../src/engine/report";
import { fetchJson, clearHttpCache } from "../src/engine/http";
import { hireUpstream, _activeHireCount } from "../src/upstream";
import { collectSources, matchContentHash, normalizeHash } from "../src/verify";
import { buildAnalystFacts, maybeSummarize } from "../src/llm";
import { keccak256 } from "js-sha3";
import { createHash } from "node:crypto";
import type { Resolution, Source, TokenReport } from "../src/engine/types";

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

// Async variant for network-layer tests (with an injected fetch stub). Collected
// and awaited before the final summary prints.
const pending: Promise<void>[] = [];
function atest(name: string, fn: () => Promise<void>) {
  pending.push(
    fn().then(
      () => {
        passed++;
        console.log(`  ✓ ${name}`);
      },
      (e: any) => {
        failed++;
        console.error(`  ✗ ${name}\n    ${e.message}`);
      }
    )
  );
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

// ------------------------------------------------- parseSolanaSecurity (SPL/T-2022)
console.log("parseSolanaSecurity (Solana authority mapping)");

test("maps Solana authorities and Token-2022 extensions", () => {
  const r = parseSolanaSecurity({
    holder_count: "1000",
    holders: [
      { percent: "0.2", is_locked: 0, tag: "" },
      { percent: "0.1", is_locked: 1, tag: "" }, // locked → excluded
      { percent: "0.15", is_locked: 0, tag: "Raydium Pool" }, // tagged pool → excluded
    ],
    mintable: { authority: [], status: "1" },
    freezable: { authority: ["x"], status: "1" },
    balance_mutable_authority: { authority: [], status: "1" },
    non_transferable: "0",
    transfer_hook: [{ program_id: "abc" }],
    transfer_fee: { current_fee_rate: "100" },
    metadata_mutable: { status: "1", metadata_upgrade_authority: [{ address: "x", malicious_address: 1 }] },
    trusted_token: "0",
  });
  assert.equal(r.isMintable, true); // mint authority live
  assert.equal(r.freezeAuthorityActive, true);
  assert.equal(r.ownerCanChangeBalance, true); // balance-mutate authority
  assert.equal(r.transferHook, true);
  assert.equal(r.transferFee, true);
  assert.equal(r.metadataMutable, true);
  assert.equal(r.metadataMaliciousAuthority, true);
  assert.equal(r.nonTransferable, false);
  assert.equal(r.trustedToken, false);
  assert.equal(r.topHolderConcentrationPct, 20); // only the 0.2 EOA counts
});

test("revoked Solana authorities parse as false", () => {
  const r = parseSolanaSecurity({
    holders: [],
    mintable: { authority: [], status: "0" },
    freezable: { authority: [], status: "0" },
    trusted_token: "1",
  });
  assert.equal(r.isMintable, false);
  assert.equal(r.freezeAuthorityActive, false);
  assert.equal(r.trustedToken, true);
});

// -------------------------------------------------- assessRisk (Solana signals)
console.log("assessRisk (Solana authority signals)");

test("live freeze authority is critical (de-facto honeypot)", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({ freezeAuthorityActive: true }));
  assert.ok(r.flags.some((f) => f.code === "FREEZE_AUTHORITY_ACTIVE" && f.level === "critical"));
  assert.equal(r.level, "critical");
});

test("non-transferable and malicious metadata authority are critical", () => {
  const nt = assessRisk(HEALTHY(), SRC, null, undefined, holders({ nonTransferable: true }));
  assert.ok(nt.flags.some((f) => f.code === "NON_TRANSFERABLE" && f.level === "critical"));
  const mal = assessRisk(HEALTHY(), SRC, null, undefined, holders({ metadataMaliciousAuthority: true, metadataMutable: true }));
  assert.ok(mal.flags.some((f) => f.code === "MALICIOUS_METADATA_AUTHORITY"));
  // METADATA_MUTABLE is suppressed when the authority is already flagged malicious.
  assert.ok(!mal.flags.some((f) => f.code === "METADATA_MUTABLE"));
});

test("transfer hook flagged high; trusted token is a positive", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({ transferHook: true, trustedToken: true }));
  assert.ok(r.flags.some((f) => f.code === "TRANSFER_HOOK" && f.level === "high"));
  const trusted = r.flags.find((f) => f.code === "TRUSTED_TOKEN");
  assert.ok(trusted && trusted.category === "positive");
});

test("Solana concentration wording discloses pool-account caveat", () => {
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({ topHolderConcentrationPct: 55, freezeAuthorityActive: false }));
  const flag = r.flags.find((f) => f.code === "HOLDER_CONCENTRATION_HIGH");
  assert.ok(flag && /AMM pool/.test(flag.message));
});

test("Solana single-source result still earns high confidence", () => {
  // freezeAuthorityActive being defined marks this as a Solana result (covers
  // both pillars), so market + Solana = high even with no Honeypot.is source.
  const r = assessRisk(HEALTHY(), SRC, null, undefined, holders({ freezeAuthorityActive: false }));
  assert.equal(r.confidence, "high");
});

// ------------------------------------------------------ renderMarkdown (brief)
console.log("renderMarkdown (human-readable brief)");

function sampleReport(over: Partial<TokenReport> = {}): TokenReport {
  return {
    schemaVersion: "1.0",
    input: { chain: "base", token: "0xabc" },
    resolved: { name: cited("Demo"), symbol: cited("DEMO"), address: "0xABC", chain: "base", dexId: "uniswap", pairAddress: "0xpair" },
    resolution: { method: "address", candidateTokens: 1, note: "" },
    market: { priceUsd: cited(0.0000012), liquidityUsd: cited(19_313_986), volume24hUsd: cited(547_681), fdvUsd: cited(1_000_000) },
    holders: { holderCount: cited(569276), topHolderConcentrationPct: cited(39), isMintable: cited(false) },
    security: { ownershipRenounced: cited(true), canBlacklist: cited(true) },
    riskScore: 25,
    riskLevel: "medium",
    scores: { market: { score: 0, level: "low" }, contract: { score: 0, level: "low" }, holders: { score: 25, level: "medium" } },
    confidence: "high",
    confidenceNote: "All pillars resolved.",
    flags: [
      { code: "HOLDER_CONCENTRATION_MODERATE", level: "medium", category: "holders", message: "Top holders control 39.0% of supply — moderate concentration.", source: SRC },
      { code: "CEX_LISTED", level: "low", category: "positive", message: "Listed on Binance — legitimacy signal.", source: SRC },
    ],
    sources: [SRC],
    generatedAt: "2026-07-03T00:00:00Z",
    contentNote: "keccak256 committed on-chain.",
    ...over,
  };
}

function cited<T>(value: T) {
  return { value, source: SRC };
}

test("brief carries verdict, subscores, findings and sources", () => {
  const md = renderMarkdown(sampleReport());
  assert.ok(md.includes("MODERATE RISK"));
  assert.ok(md.includes("25/100"));
  assert.ok(/confidence:\s*\*\*high\*\*/.test(md));
  assert.ok(md.includes("Holder distribution"));
  assert.ok(md.includes("moderate concentration"));
  assert.ok(md.includes("Positive signals")); // CEX flag surfaced separately
  assert.ok(md.includes("1. **test**")); // numbered source list
});

test("brief uses en-US number grouping regardless of host locale", () => {
  const md = renderMarkdown(sampleReport());
  assert.ok(md.includes("$19,313,986"), "liquidity should use comma-thousands grouping");
  assert.ok(md.includes("569,276"), "holder count should use comma grouping");
});

test("critical report renders a red verdict and groups criticals first", () => {
  const md = renderMarkdown(sampleReport({
    riskScore: 85,
    riskLevel: "critical",
    flags: [
      { code: "FREEZE_AUTHORITY_ACTIVE", level: "critical", category: "contract", message: "Freeze authority is live.", source: SRC },
      { code: "PAIR_NEW", level: "medium", category: "market", message: "Pair is new.", source: SRC },
    ],
  }));
  assert.ok(md.startsWith("# 🔴"));
  assert.ok(md.includes("CRITICAL RISK"));
  assert.ok(md.indexOf("CRITICAL") < md.indexOf("MEDIUM")); // severity order
});

test("brief with no risk findings states so cleanly", () => {
  const md = renderMarkdown(sampleReport({
    flags: [{ code: "NO_MAJOR_FLAGS", level: "low", category: "market", message: "No major red flags.", source: SRC }],
  }));
  assert.ok(md.includes("No material risk findings"));
});

// -------------------------------------------------------- http (retry + cache)
console.log("fetchJson (retry / cache / timeout)");

// A fetch stub that returns canned Responses per call, tracking call count.
function stubFetch(responses: Array<() => Response | Promise<Response>>) {
  let calls = 0;
  const impl = (async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return r();
  }) as unknown as typeof fetch;
  return { impl, get calls() { return calls; } };
}

function json(body: any, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

atest("retries on 5xx then succeeds", async () => {
  clearHttpCache();
  const stub = stubFetch([
    () => new Response("busy", { status: 503 }),
    () => new Response("busy", { status: 503 }),
    () => json({ ok: 1 }),
  ]);
  const res = await fetchJson<{ ok: number }>("https://x.test/a", { fetchImpl: stub.impl, retryBaseMs: 1, cacheTtlMs: 0 });
  assert.equal(res.data.ok, 1);
  assert.equal(stub.calls, 3);
});

atest("does NOT retry a 404 (fails fast)", async () => {
  clearHttpCache();
  const stub = stubFetch([() => new Response("nope", { status: 404 })]);
  await assert.rejects(
    fetchJson("https://x.test/b", { fetchImpl: stub.impl, retryBaseMs: 1, retries: 3, cacheTtlMs: 0 }),
    /404/
  );
  assert.equal(stub.calls, 1); // no retries burned on a hard 404
});

atest("throws after exhausting retries", async () => {
  clearHttpCache();
  const stub = stubFetch([() => new Response("busy", { status: 500 })]);
  await assert.rejects(fetchJson("https://x.test/c", { fetchImpl: stub.impl, retryBaseMs: 1, retries: 2, cacheTtlMs: 0 }), /500/);
  assert.equal(stub.calls, 3); // 1 + 2 retries
});

atest("cache serves a hit and preserves the original fetchedAt", async () => {
  clearHttpCache();
  const stub = stubFetch([() => json({ n: 1 }), () => json({ n: 2 })]);
  const first = await fetchJson<{ n: number }>("https://x.test/d", { fetchImpl: stub.impl, cacheTtlMs: 10_000 });
  const second = await fetchJson<{ n: number }>("https://x.test/d", { fetchImpl: stub.impl, cacheTtlMs: 10_000 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.data.n, 1); // served from cache, not the second response
  assert.equal(second.fetchedAt, first.fetchedAt); // citation stays honest
  assert.equal(stub.calls, 1); // only one network call
});

// --------------------------------------------------- A2A upstream state machine
// The upstream hire path (provider hires + pays another CAP agent mid-order) has
// no live-CAP coverage, so we drive it here against a fake EventStream + client.
// Every test uses UNIQUE ids because hireUpstream fans events out to a shared
// module-global set of in-flight hires — unique ids keep tests from cross-talking.

const flush = () => new Promise((r) => setTimeout(r, 5));

// Minimal stand-in for the SDK EventStream. Records how many listeners were
// attached (to prove the no-leak invariant) and lets a test emit events.
function fakeStream() {
  const handlers = new Map<string, Array<(ev: any) => void>>();
  let onCount = 0;
  return {
    onCount: () => onCount,
    on(type: string, h: (ev: any) => void) {
      onCount++;
      const a = handlers.get(type) ?? [];
      a.push(h);
      handlers.set(type, a);
    },
    onAny() {},
    close() {},
    err() {
      return null;
    },
    emit(type: string, ev: Record<string, any>) {
      for (const h of handlers.get(type) ?? []) h({ type, raw: {}, ...ev });
    },
  } as any;
}

// Fake AgentClient covering only the calls hireUpstream makes. Overridable per
// test to simulate failures.
function fakeClient(over: Record<string, any> = {}) {
  return {
    negotiateOrder: async (_req: any) => ({ negotiationId: over.negotiationId ?? "n1" }),
    // Models the real backend: getOrder returns the TRUE negotiation id of the
    // queried order (here by the test convention "oX" -> "nX"), so the fallback
    // only ever matches the hire that actually owns the order — never a sibling.
    getOrder: async (id: string) => ({ orderId: id, negotiationId: "n" + id.slice(1) }),
    payOrder: async (_id: string) => ({ txHash: "0xpay" }),
    getDelivery: async (_id: string) => ({
      orderId: over.orderId ?? "o1",
      deliverableSchema: over.deliverableSchema ?? JSON.stringify({ provider: "upstream", note: "ok" }),
      deliverableText: over.deliverableText ?? "",
      contentHash: over.contentHash ?? "0xcontent",
    }),
    ...(over.overrides ?? {}),
  } as any;
}

const REQ = JSON.stringify({ chain: "base", token: "0x1" });

atest("upstream hire settles to a cited annex on completion", async () => {
  const stream = fakeStream();
  const client = fakeClient({ negotiationId: "nA" });
  const p = hireUpstream(client, stream, "svc_A", REQ, 5_000);
  await flush(); // let negotiateOrder resolve so negotiationId is known
  stream.emit("order_created", { order_id: "oA", negotiation_id: "nA" });
  await flush(); // payOrder resolves, orderId is set
  stream.emit("order_completed", { order_id: "oA" });
  const annex = await p;
  assert.ok(annex, "expected an annex");
  assert.equal(annex!.serviceId, "svc_A");
  assert.equal(annex!.orderId, "oA");
  assert.equal(annex!.contentHash, "0xcontent");
  assert.deepEqual(annex!.deliverable, { provider: "upstream", note: "ok" });
  assert.equal(annex!.source.provider, "CAP service svc_A");
});

atest("upstream negotiation rejection yields null (base report unaffected)", async () => {
  const stream = fakeStream();
  const client = fakeClient({ negotiationId: "nB" });
  const p = hireUpstream(client, stream, "svc_B", REQ, 5_000);
  await flush();
  stream.emit("order_negotiation_rejected", { negotiation_id: "nB", reason: "busy" });
  const annex = await p;
  assert.equal(annex, null);
});

atest("upstream hire times out without hanging", async () => {
  const stream = fakeStream();
  const client = fakeClient({ negotiationId: "nC" });
  // No events emitted; the internal hard timeout must resolve it to null.
  const annex = await hireUpstream(client, stream, "svc_C", REQ, 30);
  assert.equal(annex, null);
});

atest("order_created without negotiation_id falls back to getOrder", async () => {
  const stream = fakeStream();
  const client = fakeClient({ negotiationId: "nD" });
  const p = hireUpstream(client, stream, "svc_D", REQ, 5_000);
  await flush();
  // Event omits negotiation_id → hire must resolve it via getOrder and still match.
  stream.emit("order_created", { order_id: "oD" });
  await flush();
  stream.emit("order_completed", { order_id: "oD" });
  const annex = await p;
  assert.ok(annex, "expected annex via getOrder fallback");
  assert.equal(annex!.orderId, "oD");
});

atest("shared stream keeps six listeners across many hires (no leak)", async () => {
  const stream = fakeStream();
  for (let i = 0; i < 3; i++) {
    const client = fakeClient({ negotiationId: `nL${i}` });
    const p = hireUpstream(client, stream, `svc_L${i}`, REQ, 5_000);
    await flush();
    stream.emit("order_created", { order_id: `oL${i}`, negotiation_id: `nL${i}` });
    await flush();
    stream.emit("order_completed", { order_id: `oL${i}` });
    assert.ok(await p, `hire ${i} should settle`);
  }
  assert.equal(stream.onCount(), 6, "exactly six listeners, regardless of hire count");
  assert.equal(_activeHireCount(), 0, "no in-flight hires left registered");
});

// ------------------------------------------------------------- verify (verifier)
console.log("verify");

test("collectSources gathers nested + deduplicates by url", () => {
  const a: Source = { provider: "DexScreener", url: "https://dex/x", fetchedAt: "t" };
  const b: Source = { provider: "GoPlus", url: "https://goplus/y", fetchedAt: "t" };
  const report = {
    resolved: { name: { value: "X", source: a } },
    market: { priceUsd: { value: 1, source: a } }, // same url as resolved -> deduped
    holders: { holderCount: { value: 9, source: b } },
    flags: [{ code: "F", source: b }], // duplicate url again
    sources: [a, b],
  };
  const got = collectSources(report).map((s) => s.url).sort();
  assert.deepEqual(got, ["https://dex/x", "https://goplus/y"]);
});

test("collectSources finds a nested source even if absent from sources[]", () => {
  const nested: Source = { provider: "Honeypot.is", url: "https://hp/z", fetchedAt: "t" };
  const report = { contract: { isHoneypot: { value: false, source: nested } }, sources: [] };
  assert.deepEqual(collectSources(report).map((s) => s.url), ["https://hp/z"]);
});

test("matchContentHash detects keccak256 with 0x prefix", () => {
  const payload = JSON.stringify({ riskScore: 10, sources: [] });
  const hash = "0x" + keccak256(payload);
  assert.equal(matchContentHash(payload, hash), "keccak256");
});

test("matchContentHash detects sha256 without prefix", () => {
  const payload = "hello-quanta";
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  assert.equal(matchContentHash(payload, hash), "sha256");
});

test("matchContentHash returns null on a tampered payload", () => {
  const payload = JSON.stringify({ riskScore: 10 });
  const hash = "0x" + keccak256(payload);
  assert.equal(matchContentHash(payload + " ", hash), null); // one extra byte
});

test("normalizeHash strips 0x and lowercases", () => {
  assert.equal(normalizeHash("0xABCdef"), "abcdef");
  assert.equal(normalizeHash("  ABC  "), "abc");
});

// ----------------------------------------------------------- llm (dgrid overlay)
console.log("llm (dgrid overlay)");

const LLM_REPORT: any = {
  resolved: {
    name: { value: "WrappedX", source: SRC },
    symbol: { value: "WX", source: SRC },
    chain: "base",
    address: "0x",
    dexId: "d",
    pairAddress: "0xp",
  },
  market: {
    priceUsd: { value: 1.5, source: SRC },
    liquidityUsd: { value: 1000, source: SRC },
    volume24hUsd: { value: 500, source: SRC },
  },
  riskScore: 10,
  riskLevel: "low",
  confidence: "high",
  scores: {
    market: { score: 0, level: "low" },
    contract: { score: 0, level: "low" },
    holders: { score: 0, level: "low" },
  },
  flags: [{ code: "F1", level: "low", category: "market", message: "thin liquidity" }],
  sources: [SRC],
};

test("buildAnalystFacts extracts only the grounding fields", () => {
  const f = buildAnalystFacts(LLM_REPORT);
  assert.equal(f.token, "WrappedX (WX)");
  assert.equal(f.chain, "base");
  assert.equal(f.priceUsd, 1.5);
  assert.equal(f.riskLevel, "low");
  assert.deepEqual(f.flags, ["[low/market] thin liquidity"]);
});

atest("maybeSummarize returns undefined when no key is configured", async () => {
  const d = process.env.DGRID_API_KEY;
  const a = process.env.ANTHROPIC_API_KEY;
  delete process.env.DGRID_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const out = await maybeSummarize(LLM_REPORT, {
    fetchImpl: (async () => {
      throw new Error("must not fetch without a key");
    }) as any,
  });
  assert.equal(out, undefined);
  if (d) process.env.DGRID_API_KEY = d;
  if (a) process.env.ANTHROPIC_API_KEY = a;
});

atest("maybeSummarize posts to /chat/completions with bearer auth and parses content", async () => {
  const d = process.env.DGRID_API_KEY;
  process.env.DGRID_API_KEY = "sk-test";
  const stub = (async (url: string, init: any) => {
    assert.ok(String(url).endsWith("/chat/completions"), "hits chat completions");
    assert.equal(init.headers.authorization, "Bearer sk-test", "bearer auth");
    return { ok: true, json: async () => ({ choices: [{ message: { content: "  Grounded brief.  " } }] }) };
  }) as any;
  const out = await maybeSummarize(LLM_REPORT, { fetchImpl: stub });
  assert.equal(out, "Grounded brief.");
  if (d) process.env.DGRID_API_KEY = d;
  else delete process.env.DGRID_API_KEY;
});

atest("maybeSummarize degrades to undefined on a non-200 response", async () => {
  const d = process.env.DGRID_API_KEY;
  process.env.DGRID_API_KEY = "sk-test";
  const out = await maybeSummarize(LLM_REPORT, {
    fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as any,
  });
  assert.equal(out, undefined);
  if (d) process.env.DGRID_API_KEY = d;
  else delete process.env.DGRID_API_KEY;
});

// ----------------------------------------------------------------------- result
Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
