import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { AgentClient, type Config } from "@croo-network/sdk";
import { buildRegistry, type AgentServiceEntry } from "./registry";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export function crooConfig(): Config {
  return {
    baseURL: process.env.CROO_API_URL || "https://api.croo.network",
    wsURL: process.env.CROO_WS_URL || "wss://api.croo.network/ws",
    rpcURL: process.env.CROO_RPC_URL || "https://mainnet.base.org",
  };
}

/** Provider client — the agent that lists the service and earns USDC. */
export function providerClient(): AgentClient {
  return new AgentClient(crooConfig(), required("CROO_SDK_KEY"));
}

/** Requester client — a second agent used to hire the provider (A2A demo). */
export function requesterClient(): AgentClient {
  return new AgentClient(crooConfig(), required("CROO_REQUESTER_SDK_KEY"));
}

/**
 * Zodyl's client — the ecosystem's portfolio agent. Uses CROO_ZODYL_SDK_KEY,
 * falling back to CROO_REQUESTER_SDK_KEY (Zodyl's existing key), so no re-config
 * is needed to bring it online as a provider.
 */
export function zodylClient(): AgentClient {
  const key = process.env.CROO_ZODYL_SDK_KEY || process.env.CROO_REQUESTER_SDK_KEY;
  if (!key) throw new Error("Set CROO_ZODYL_SDK_KEY (or CROO_REQUESTER_SDK_KEY) to Zodyl's SDK key.");
  return new AgentClient(crooConfig(), key);
}

/**
 * Buyer client for the portfolio demo — whoever hires Zodyl. Uses
 * CROO_BUYER_SDK_KEY, falling back to CROO_SDK_KEY (Quanta) for a local demo.
 * MUST be a different agent than Zodyl, or Zodyl would be buying from itself.
 */
export function buyerClient(): AgentClient {
  const key = process.env.CROO_BUYER_SDK_KEY || process.env.CROO_SDK_KEY;
  if (!key) throw new Error("Set CROO_BUYER_SDK_KEY to a funded agent (not Zodyl) to hire the portfolio service.");
  return new AgentClient(crooConfig(), key);
}

export const SERVICE_ID = process.env.CROO_SERVICE_ID || "";
export const ZODYL_SERVICE_ID = process.env.CROO_ZODYL_SERVICE_ID || "";
/** Zodyl hires Quanta per token; this is the due-diligence service it calls. */
export const QUANTA_DUE_DILIGENCE_SERVICE_ID =
  process.env.CROO_QUANTA_SERVICE_ID || process.env.CROO_SERVICE_ID || "";

/**
 * Optional A2A enrichment: a store service THIS agent hires (and pays) while
 * fulfilling each order. Leave unset to disable. The provider's AA wallet must
 * hold enough USDC to cover the upstream price + fee.
 */
export const UPSTREAM_SERVICE_ID = process.env.CROO_UPSTREAM_SERVICE_ID || "";
export const UPSTREAM_TIMEOUT_MS = Number(process.env.CROO_UPSTREAM_TIMEOUT_MS || 90_000);

/** Capability Quanta requests as an enrichment annex per order (via the router). */
export const ENRICH_CAPABILITY = process.env.CROO_ENRICH_CAPABILITY || "due-diligence";

/**
 * The live ecosystem registry: internal agents (from their service-id env vars)
 * first, then curated store fallbacks (CROO_STORE_SERVICES JSON and/or an
 * optional registry.json at repo root). This is what the capability router in
 * upstream.ts consults to decide who to hire.
 */
export function loadRegistry(): AgentServiceEntry[] {
  let extra: AgentServiceEntry[] = [];
  const file = path.resolve(process.cwd(), "registry.json");
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) extra = parsed as AgentServiceEntry[];
    }
  } catch (e: any) {
    console.warn(`⚠️  Ignoring registry.json: ${e.message}`);
  }
  return buildRegistry(process.env, extra);
}
