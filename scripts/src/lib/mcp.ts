// The MCP connector as Claude/ChatGPT use it: discovery from the 401 of /mcp, dynamic client registration, the
// consent request signed with SIWE by the wallet (plus the optional memory-key signature), the code exchange with PKCE
// S256, then JSON-RPC calls to /mcp with the access token.
import { createHash, randomBytes } from "node:crypto";
import { MEMORY_KEY_MESSAGE } from "@solvers/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { API_URL } from "../env.js";

const REDIRECT = "http://localhost:6274/oauth/callback";
const PROTOCOL = "2025-06-18";

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what}: ${res.status} non-JSON answer: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 400)}`);
  return body as T;
}

export type OAuthTokens = { accessToken: string; refreshToken: string; clientId: string };

/**
 * Full OAuth 2.1 flow of an MCP client for `account` (the wallet signs the consent SIWE message). With `memory` it also
 * signs MEMORY_KEY_MESSAGE so get_memory/save_memory work.
 */
export async function connectOAuth(account: PrivateKeyAccount, o: { memory?: boolean } = {}): Promise<OAuthTokens> {
  const probe = await fetch(`${API_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const wwwAuth = probe.headers.get("www-authenticate") ?? "";
  if (probe.status !== 401 || !wwwAuth.includes("resource_metadata")) throw new Error(`expected 401 with WWW-Authenticate from /mcp, got ${probe.status}`);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  if (!prmUrl) throw new Error(`no resource_metadata in ${wwwAuth}`);
  // The metadata URLs carry PUBLIC_API_URL; the scripts talk to API_URL (same server, maybe another host name).
  const local = (u: string) => u.replace(/^https?:\/\/[^/]+/, API_URL);
  const prm = await json<{ authorization_servers: string[]; resource: string }>(await fetch(local(prmUrl)), "protected resource metadata");
  const as = await json<Record<string, string>>(await fetch(`${local(prm.authorization_servers[0]!)}/.well-known/oauth-authorization-server`), "authorization server metadata");

  const reg = await json<{ client_id: string }>(
    await fetch(local(as.registration_endpoint!), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude (e2e)", redirect_uris: [REDIRECT] }),
    }),
    "client registration",
  );

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const authUrl = new URL(local(as.authorization_endpoint!));
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "solvers",
    resource: prm.resource,
  }))
    authUrl.searchParams.set(k, v);
  // The server stores the request and redirects to the web app's consent screen (/connect?req=...).
  const redirect = await fetch(authUrl, { redirect: "manual" });
  const location = redirect.headers.get("location") ?? "";
  const req = /[?&]req=([A-Za-z0-9_]+)/.exec(location)?.[1];
  if (redirect.status !== 302 || !location.includes("/connect?") || !req) throw new Error(`authorize should redirect to /connect: ${redirect.status} ${location}`);
  const info = await json<{ clientName?: string; extensionUrl?: string; memoryMessage?: string }>(await fetch(`${API_URL}/oauth/authorize/info?req=${req}`), "authorize info");
  if (!info.clientName || !info.extensionUrl) throw new Error(`incomplete request info: ${JSON.stringify(info)}`);
  if (info.memoryMessage && info.memoryMessage !== MEMORY_KEY_MESSAGE) throw new Error(`unexpected memory message: ${info.memoryMessage}`);

  const nonce = await json<{ message: string }>(await fetch(`${API_URL}/oauth/authorize/nonce?req=${req}&address=${account.address}`), "consent nonce");
  const done = await json<{ redirectTo?: string }>(
    await fetch(`${API_URL}/oauth/authorize/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        req,
        message: nonce.message,
        signature: await account.signMessage({ message: nonce.message }),
        memorySignature: o.memory === false ? undefined : await account.signMessage({ message: MEMORY_KEY_MESSAGE }),
      }),
    }),
    "consent",
  );
  if (!done.redirectTo) throw new Error(`consent not completed: ${JSON.stringify(done)}`);
  const cb = new URL(done.redirectTo);
  if (cb.searchParams.get("state") !== state) throw new Error("state mismatch");

  const tok = await json<{ access_token?: string; refresh_token?: string }>(
    await fetch(local(as.token_endpoint!), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: cb.searchParams.get("code")!,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        resource: prm.resource,
      }),
    }),
    "token exchange",
  );
  if (!tok.access_token || !tok.refresh_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, clientId: reg.client_id };
}

type RpcResult = { content?: { type?: string; text: string }[]; isError?: boolean; tools?: { name: string }[]; instructions?: string; [k: string]: unknown };

let rpcId = 0;

/** One JSON-RPC call to /mcp. */
export async function rpc(token: string, method: string, params: unknown = {}): Promise<RpcResult> {
  const res = await fetch(`${API_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE: take the last `data:` line.
  const payload = text.trimStart().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) ?? text);
  let body: { result?: RpcResult; error?: unknown };
  try {
    body = JSON.parse(payload) as typeof body;
  } catch {
    throw new Error(`${method}: ${res.status} ${text.slice(0, 300)}`);
  }
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result!;
}

export const initialize = (token: string, client = "e2e") =>
  rpc(token, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: client, version: "1" } });

/** Calls a tool and returns its text; a tool error (`isError`) throws with the text. */
export async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
}

/** The `session_id` an activate_solver answer carries. */
export const sessionIdOf = (text: string): string | undefined => /session_id: (ses_[0-9a-f]+)/.exec(text)?.[1];
