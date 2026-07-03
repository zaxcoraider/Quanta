# croo-intel-agent — Verifiable Token Due-Diligence

A paid, callable AI agent for the **[CROO Agent Store](https://agent.croo.network/)**, built on the
**CROO Agent Protocol (CAP)**. It sells one thing and does it well:

> **Token Due-Diligence Report** — give it a chain + token, get back a structured,
> **source-cited** risk report. Settles in **USDC on Base**.

**Track:** Research & Intelligence Agents (paid research with *verifiable sources*).
Secondary fit: DeFi / On-chain Ops.

## Why it's different

The store already has many "DYOR / wallet-risk" bots. The differentiator here is
**verifiability**: every factual claim in the deliverable carries a `source`
(provider + re-fetchable URL + `fetchedAt`). Buyers — human *or* other agents —
can independently re-check every number. Risk heuristics are transparent, not a
black box, and a `keccak256` of the deliverable is committed on-chain by CAP at
settlement for tamper-evidence.

Signals span independent, free (no-key) sources — all cited, and all degrading
gracefully when a source doesn't cover a chain:

1. **Market structure** — DexScreener (liquidity depth, pair age, volume/liquidity
   turnover, FDV vs liquidity). All chains.
2. **Contract behavior** — an on-chain buy/sell simulation via Honeypot.is
   (honeypot / unsellable detection + real buy/sell/transfer taxes, EVM chains).
3. **Holder distribution + contract-capability surface** — GoPlus Labs.
   *Distribution:* concentration among *dumpable non-contract wallets*, residual
   owner/creator holdings, LP-lock share. *Capabilities:* the dangerous powers the
   contract retains — mintable, pausable transfers, address blacklist, arbitrary
   balance rewrite, upgradeable proxy, self-destruct, ownership take-back, hidden
   owner, whitelist gating, modifiable slippage, "creator previously shipped a
   honeypot", and more. Plus **CEX-listing** as a positive legitimacy signal.
   EVM chains.
4. **Solana coverage** — GoPlus Labs *Solana* token-security (SPL / Token-2022).
   The rug vectors differ from EVM: live **mint authority** (infinite supply),
   **freeze authority** (freeze your account → de-facto honeypot), non-transferable
   tokens, transfer hooks / fees, mutable or malicious metadata authority, and
   holder concentration — with GoPlus's Solana **trust list** as a positive signal.
   One Solana call covers both the authority and holder dimensions, so a Solana
   token that used to return market-data-only now gets a full report.

Two design choices keep this from false-flagging legitimate tokens:

- **Concentration excludes contract holders** (protocols, bridges, LP pools,
  lockers) and locked/burned supply, so blue chips like WETH don't read as
  concentrated — it isolates the share that maps to single-wallet dump risk.
- **Owner-gated powers are ownership-aware.** A blacklist or pause function is
  only a live threat while an owner can call it, so those flags are suppressed
  when ownership is verifiably renounced (e.g. PEPE retains a blacklist function
  but is renounced → not flagged). Code-level dangers (self-destruct, prior-
  honeypot deployer) fire regardless.

Every report carries an **overall risk score plus per-dimension subscores**
(market / contract / holders) so buyers see *where* the risk sits, and a
**confidence** level reflecting how many of the three sources actually resolved —
so a low score on a non-EVM chain (market data only) isn't mistaken for a clean
bill of health.

## What the buyer receives

```jsonc
{
  "schemaVersion": "1.0",
  "resolved": { "name": {...}, "symbol": {...}, "address": "0x..", "chain": "base",
                "dexId": "uniswap", "pairAddress": "0x.." },
  "resolution": {                            // HOW the token was identified — auditable
    "method": "symbol-search",               // or "address" (unambiguous, preferred)
    "candidateTokens": 3,
    "note": "picked the most-canonical by pair count, oldest pair age, then total liquidity…"
  },
  "market": {
    "priceUsd":      { "value": 0.0123, "source": { "provider": "DexScreener", "url": "...", "fetchedAt": "..." } },
    "liquidityUsd":  { "value": 84210,  "source": { ... } },
    "volume24hUsd":  { "value": 12000,  "source": { ... } }
  },
  "contract": {                              // EVM only — on-chain buy/sell simulation
    "isHoneypot":        { "value": false, "source": { "provider": "Honeypot.is", "url": "...", "fetchedAt": "..." } },
    "buyTaxPct":         { "value": 0,     "source": { ... } },
    "sellTaxPct":        { "value": 0,     "source": { ... } },
    "simulationSuccess": { "value": true,  "source": { ... } }
  },
  "holders": {                               // EVM only — holder distribution & ownership (GoPlus)
    "holderCount":                { "value": 569239, "source": { "provider": "GoPlus Labs", "url": "...", "fetchedAt": "..." } },
    "topHolderConcentrationPct":  { "value": 39,     "source": { ... } },  // dumpable non-contract wallets only
    "ownerPercentPct":            { "value": 0,      "source": { ... } },
    "isMintable":                 { "value": false,  "source": { ... } },
    "canTakeBackOwnership":       { "value": false,  "source": { ... } },
    "hiddenOwner":                { "value": false,  "source": { ... } },
    "isOpenSource":               { "value": true,   "source": { ... } }
  },
  "security": {                              // EVM only — contract-capability surface (GoPlus)
    "ownershipRenounced":  { "value": true,  "source": { ... } },  // owner-gated flags suppressed when true
    "canBlacklist":        { "value": true,  "source": { ... } },  // present but dormant → not flagged
    "selfdestruct":        { "value": false, "source": { ... } },
    "isProxy":             { "value": false, "source": { ... } },
    "cexListed":           { "value": true,  "source": { ... } },  // positive legitimacy signal
    "cexList":             { "value": ["Binance", "Coinbase"], "source": { ... } }
  },
  "riskScore": 45,                           // overall, across all dimensions
  "riskLevel": "high",
  "scores": {                                // per-dimension breakdown — WHERE the risk sits
    "market":   { "score": 45, "level": "high" },
    "contract": { "score": 0,  "level": "low" },
    "holders":  { "score": 25, "level": "medium" }
  },
  "confidence": "high",                      // how many of the 3 sources resolved
  "confidenceNote": "All three sources resolved (market, on-chain simulation, holder/contract data).",
  "flags": [ { "code": "LIQUIDITY_LOW", "level": "high", "category": "market", "message": "...", "source": { ... } } ],
  "upstream": {                              // optional A2A annex — see below
    "serviceId": "svc_..", "orderId": "ord_..",
    "contentHash": "0x..",                   // the UPSTREAM order's own on-chain proof
    "deliverable": { ... }, "source": { ... }
  },
  "summary": "…optional Claude analyst summary…",
  "sources": [ /* de-duped list of everything cited */ ]
}
```

## Impersonation-resistant symbol resolution

Scam tokens routinely spoof a huge single-pair "liquidity" figure (price is
manipulable on a fake token, and reported liquidity is priced reserves), so
resolving a symbol to *deepest liquidity* is unsafe — a 0.8-day-old fake "PEPE"
can report more liquidity than the real one. When the input is a symbol, this
agent instead:

1. filters to **exact symbol matches** on the **requested chain only** (never a
   silent cross-chain fallback — wrong-network data is worse than an error);
2. groups pairs by token contract and picks the most canonical by
   **pair count → oldest pair age → total liquidity**;
3. **discloses the ambiguity** in the report (`resolution` + a `SYMBOL_AMBIGUOUS`
   risk flag telling the buyer to re-request by address).

Address input skips all heuristics and is always unambiguous.

## A2A composability: this agent also *hires* agents

Set `CROO_UPSTREAM_SERVICE_ID` to any other Agent Store service and the
provider becomes a CAP **requester inside its own delivery**: while fulfilling
a paid order it negotiates, pays USDC, and waits for the upstream deliverable,
then attaches it to the report as a cited annex — including the upstream
order's own on-chain `contentHash`, so the whole agent supply chain is
verifiable hop by hop. The hire is strictly bounded (`CROO_UPSTREAM_TIMEOUT_MS`,
default 90 s) and best-effort: any upstream failure just means the base report
ships without the annex — our own SLA is never endangered.

## Architecture

```
src/
  provider.ts        CAP provider loop — accepts negotiations, delivers on payment (idempotent)
  requester-demo.ts  A2A demo: a 2nd agent hires + pays this agent, prints the report
  upstream.ts        A2A upstream hop: this agent hires ANOTHER CAP agent mid-delivery
  cli.ts             Run the engine standalone (no CROO keys) — great for the demo video
  config.ts          Builds AgentClient(s) from env
  llm.ts             Optional Claude (claude-opus-4-8) analyst summary
  engine/
    index.ts         runResearch(input) -> TokenReport
    dexscreener.ts   Live market data (free, no key) + impersonation-resistant resolution
    honeypot.ts      Contract-behavior check via on-chain buy/sell simulation (free, no key, EVM)
    holders.ts       EVM holder distribution + contract-capability surface via GoPlus (free, no key)
    solana.ts        Solana SPL/Token-2022 authority + holder check via GoPlus Solana (free, no key)
    risk.ts          Transparent, auditable heuristics + per-dimension subscores + confidence
    report.ts        Renders a TokenReport as a human-readable Markdown brief (`--md`)
    types.ts         Report schema (Cited<T> = value + source)
test/
  engine.test.ts     Offline unit tests (no network, no keys) — `npm test`
```

## Quick start

```bash
npm install
cp .env.example .env      # then fill in your keys

# 0) Offline unit tests — no network, no keys:
npm test

# 1) Prove the engine works with zero keys (live data):
npm run research -- base 0x4200000000000000000000000000000000000006
npm run research -- ethereum PEPE
npm run research -- solana BONK              # Solana coverage (mint/freeze authority…)
npm run research -- ethereum PEPE --md       # human-readable Markdown brief instead of JSON

# 2) Register the provider agent + service in the dashboard (see below), put the
#    CROO_SDK_KEY and CROO_SERVICE_ID in .env, then run the provider:
npm run provider

# 3) In another terminal, hire it from a second (funded) agent — A2A:
npm run demo -- base 0xYourTokenAddress
```

## CAP integration notes

CROO agent + service are created in the **dashboard** ([agent.croo.network](https://agent.croo.network/)),
which mints an AA wallet + Agent DID and issues a one-time SDK key. This repo
handles everything after that via `@croo-network/sdk` (v0.2.1).

**Provider lifecycle** (`src/provider.ts`):

| Step | SDK method / event | Notes |
|------|--------------------|-------|
| Connect | `client.connectWebSocket()` | Returns an auto-reconnecting `EventStream`. |
| New request | event `order_negotiation_created` | We `getNegotiation()` and validate `requirements` JSON. |
| Accept | `client.acceptNegotiation(negotiationId)` | Backend submits `createOrder` on-chain; returns `{ negotiation, order }`. |
| Reject bad input | `client.rejectNegotiation(id, reason)` | Malformed requirements never become orders. |
| Payment locked | event `order_paid` | Escrow in CAPVault. **Only now** do we run paid work. |
| Deliver | `client.deliverOrder(orderId, { deliverableType: "schema", deliverableSchema })` | keccak256 committed on-chain; verification → USDC settles. |
| Settled | event `order_completed` | Funds land in provider AA wallet. |

**Requester lifecycle** (`src/requester-demo.ts`): connect the event stream
*first* (avoids racing a fast provider accept), then `negotiateOrder()` →
`payOrder()` on `order_created` → read `getDelivery()` on `order_completed`
(`delivery.contentHash` is the on-chain proof). Every terminal event
(negotiation rejected/expired, order rejected/expired) and a global timeout are
handled — the demo can fail loudly, but it can never hang.

**Payment-state hygiene:** the provider keys every handler on first-seen
negotiation/order IDs, so websocket reconnects or event redelivery can never
double-accept or double-deliver; delivery failures surface via
`rejectOrder(reason)` so the SLA/refund path stays honest. When upstream hiring
is enabled, events for orders where this agent is the *requester* are filtered
out by service id so the provider never tries to fulfill its own purchases.

## Configuration

See `.env.example`. Endpoints default to Base mainnet
(`api.croo.network`, `wss://api.croo.network/ws`, `https://mainnet.base.org`).
`ANTHROPIC_API_KEY` is optional — without it the agent still delivers the full
deterministic, source-cited report, just without the prose summary.

## License

MIT.
