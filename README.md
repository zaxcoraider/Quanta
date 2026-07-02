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

Signals span two independent, free (no-key) sources: **market structure** from
DexScreener (liquidity depth, pair age, volume/liquidity turnover, FDV vs
liquidity) and **contract behavior** from an on-chain buy/sell simulation via
Honeypot.is (honeypot / unsellable detection + real buy/sell/transfer taxes, EVM
chains). Both are cited; the contract check degrades gracefully on non-EVM chains.

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
  "riskScore": 45,
  "riskLevel": "high",
  "flags": [ { "code": "LIQUIDITY_LOW", "level": "high", "message": "...", "source": { ... } } ],
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
    risk.ts          Transparent, auditable risk heuristics (market + contract + resolution)
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

# 1) Prove the engine works with zero keys (live DexScreener data):
npm run research -- base 0x4200000000000000000000000000000000000006
npm run research -- ethereum PEPE

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
