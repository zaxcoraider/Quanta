import * as dotenv from "dotenv";
import { AgentClient, type Config } from "@croo-network/sdk";

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

export const SERVICE_ID = process.env.CROO_SERVICE_ID || "";

/**
 * Optional A2A enrichment: a store service THIS agent hires (and pays) while
 * fulfilling each order. Leave unset to disable. The provider's AA wallet must
 * hold enough USDC to cover the upstream price + fee.
 */
export const UPSTREAM_SERVICE_ID = process.env.CROO_UPSTREAM_SERVICE_ID || "";
export const UPSTREAM_TIMEOUT_MS = Number(process.env.CROO_UPSTREAM_TIMEOUT_MS || 90_000);
