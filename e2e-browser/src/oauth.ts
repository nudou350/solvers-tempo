// The MCP connector client side of scenario 8, like Claude/ChatGPT: discovery from the 401 of /mcp, dynamic client
// registration, an authorization URL with PKCE S256 (opened in the BROWSER, where the person signs in and consents),
// then the code exchange and MCP calls with the access token.
import "./env.js";
import { createHash, randomBytes } from "node:crypto";

export const REDIRECT_URI = "http://localhost:6274/oauth/callback";

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export type OAuthStart = { authorizeUrl: string; state: string; verifier: string; clientId: string; tokenEndpoint: string; resource: string; mcpUrl: string };

/** Discovery + registration + PKCE, starting from the connector address the site shows (e.g. http://127.0.0.1:3028/mcp). */
export async function startOAuth(connectorUrl: string, clientName: string): Promise<OAuthStart> {
  const probe = await fetch(connectorUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const www = probe.headers.get("www-authenticate") ?? "";
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  if (probe.status !== 401 || !prmUrl) throw new Error(`expected 401 + resource_metadata from ${connectorUrl}, got ${probe.status} ${www}`);
  const prm = await json<{ authorization_servers: string[]; resource: string }>(await fetch(prmUrl), "protected resource metadata");
  const as = await json<Record<string, string>>(await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`), "authorization server metadata");
  const reg = await json<{ client_id: string }>(
    await fetch(as.registration_endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI] }) }),
    "client registration",
  );
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(8).toString("hex");
  const u = new URL(as.authorization_endpoint!);
  const params = {
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    scope: "solvers",
    resource: prm.resource,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return { authorizeUrl: u.toString(), state, verifier, clientId: reg.client_id, tokenEndpoint: as.token_endpoint!, resource: prm.resource, mcpUrl: connectorUrl };
}

/** Code -> tokens (PKCE verifier). */
export async function exchangeCode(s: OAuthStart, code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const tok = await json<{ access_token?: string; refresh_token?: string }>(
    await fetch(s.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: s.verifier, client_id: s.clientId, redirect_uri: REDIRECT_URI, resource: s.resource }),
    }),
    "token exchange",
  );
  if (!tok.access_token || !tok.refresh_token) throw new Error(`token exchange: ${JSON.stringify(tok)}`);
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token };
}

/** One MCP tool call (JSON-RPC over streamable HTTP); returns the text. */
export async function mcpCall(mcpUrl: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; status: number }> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (res.status !== 200) return { text: raw.slice(0, 300), isError: true, status: res.status };
  const payload = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) ?? raw);
  const body = JSON.parse(payload) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };
  if (body.error) return { text: JSON.stringify(body.error), isError: true, status: res.status };
  return { text: body.result?.content?.map((c) => c.text).join("\n") ?? "", isError: !!body.result?.isError, status: res.status };
}
