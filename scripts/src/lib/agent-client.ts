// Reference client of an autonomous agent: it enters the MCP connector with only its secp256k1 key, in TWO calls
// (GET /oauth/agent/nonce, POST /oauth/agent/token: SIWE signed by the key), with no client registration, PKCE or browser.
// Same contract as the agent-login guide. `rpc` and `call` are the /mcp JSON-RPC helpers.
import { MEMORY_KEY_MESSAGE } from "@solvers/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { API_URL } from "../env.js";

export { call, initialize, rpc, sessionIdOf } from "./mcp.js";

export type AgentTokens = { accessToken: string; refreshToken: string; expiresIn: number };

function toTokens(t: { access_token?: string; refresh_token?: string; expires_in?: number }, what: string): AgentTokens {
  if (!t.access_token || !t.refresh_token) throw new Error(`${what} failed: ${JSON.stringify(t)}`);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in ?? 0 };
}

/**
 * Agent login. With `memory: true` it also signs the memory key (without it get_memory/save_memory answer "memory
 * unavailable"). This does NOT authorize payments: the signed SIWE statement says so.
 */
export async function connectAgent(account: PrivateKeyAccount, o: { memory?: boolean } = {}): Promise<AgentTokens> {
  const nonceRes = await fetch(`${API_URL}/oauth/agent/nonce?address=${account.address}`);
  if (!nonceRes.ok) throw new Error(`agent nonce failed (${nonceRes.status}): ${await nonceRes.text()}`);
  const { message } = (await nonceRes.json()) as { message: string };
  const res = await fetch(`${API_URL}/oauth/agent/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      message,
      signature: await account.signMessage({ message }),
      memorySignature: o.memory ? await account.signMessage({ message: MEMORY_KEY_MESSAGE }) : undefined,
    }),
  });
  return toTokens((await res.json()) as Record<string, never>, "agent login");
}

/** Refreshes the token (the refresh token is single use: keep the new one). `client_id` is always "agent". */
export async function refreshAgent(refreshToken: string): Promise<AgentTokens> {
  const res = await fetch(`${API_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "agent" }),
  });
  return toTokens((await res.json()) as Record<string, never>, "agent refresh");
}
