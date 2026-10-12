// Pure OAuth rules (no env/database), tested in test/oauth.test.ts.

export type RefreshTokenRow = { clientId: string; revoked: boolean; expiresAt: Date };

/**
 * Can the refresh token be rotated? Everything is validated BEFORE revoking: an invalid request (wrong client_id, expired
 * token) never consumes the legitimate client's token. null = may rotate.
 */
export function refreshRejection(tok: RefreshTokenRow | undefined, clientId: string | undefined, now: Date): string | null {
  if (!tok || tok.revoked || tok.expiresAt < now) return "Invalid or expired refresh token";
  if (clientId && clientId !== tok.clientId) return "Refresh token belongs to another client";
  return null;
}

/** Fixed `client_id` of the tokens issued by the agent's direct SIWE login (no dynamic registration, no oauth_clients row). */
export const AGENT_CLIENT_ID = "agent";

/** SIWE statement of the agent login: the message says what the signature authorizes (and what it does not). */
export const AGENT_SIWE_STATEMENT = "Authorize this agent to use Solvers specialists. This does not authorize payments.";

/** Statement of the consent page: who gets access, and that no payment is authorized. */
export function consentStatement(clientName: string, redirectHost: string): string {
  // EIP-4361: the statement is one line without "\n"; keep it ASCII-safe for wallets that render it raw.
  const name = clientName.replace(/[\r\n]+/g, " ").slice(0, 80);
  return `Authorize ${name} (${redirectHost}) to use your Solvers specialists. This does not authorize payments.`;
}

/** Does the token belong to an autonomous agent (direct SIWE login) rather than an AI assistant connected by a person? */
export function isAgentClient(clientId: string | null | undefined): boolean {
  return clientId === AGENT_CLIENT_ID;
}
