import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AGENT_SIWE_STATEMENT, consentStatement, refreshRejection } from "../src/oauth/rules.js";
import { authorizePage, pageLang } from "../src/oauth/page.js";

// Refresh rotation (everything validated before revoking), SIWE statements and the consent page; no env or database.

const now = new Date("2026-01-10T00:00:00Z");
const ok = { clientId: "cli_a", revoked: false, expiresAt: new Date("2026-02-01T00:00:00Z") };

describe("refreshRejection", () => {
  it("valid token, with or without a matching client_id: may rotate", () => {
    assert.equal(refreshRejection(ok, undefined, now), null);
    assert.equal(refreshRejection(ok, "cli_a", now), null);
  });

  it("missing, revoked or expired: invalid", () => {
    assert.match(refreshRejection(undefined, "cli_a", now)!, /Invalid or expired/);
    assert.match(refreshRejection({ ...ok, revoked: true }, "cli_a", now)!, /Invalid or expired/);
    assert.match(refreshRejection({ ...ok, expiresAt: new Date("2026-01-09T00:00:00Z") }, "cli_a", now)!, /Invalid or expired/);
  });

  it("another client's client_id is refused", () => {
    assert.match(refreshRejection(ok, "cli_b", now)!, /another client/);
  });
});

describe("SIWE statements", () => {
  it("say that nothing is paid; the consent statement is one line even for a hostile client name", () => {
    assert.match(AGENT_SIWE_STATEMENT, /does not authorize payments/);
    const s = consentStatement("Evil\nURI: https://evil.test", "claude.ai");
    assert.doesNotMatch(s, /\n/);
    assert.match(s, /\(claude\.ai\).*does not authorize payments/);
  });
});

describe("consent page", () => {
  it("pageLang: ?lang wins, then Accept-Language; English by default", () => {
    assert.equal(pageLang(undefined, undefined), "en");
    assert.equal(pageLang(undefined, "pt-BR,pt;q=0.9,en;q=0.8"), "pt");
    assert.equal(pageLang(undefined, "en-US,en;q=0.9"), "en");
    assert.equal(pageLang("en", "pt-BR"), "en");
    assert.equal(pageLang("pt", "en-US"), "pt");
    assert.equal(pageLang("fr", "de"), "en");
  });

  it("English by default, Portuguese on request", () => {
    const en = authorizePage({ requestId: "ar_1", clientName: "Claude", redirectHost: "claude.ai", verified: true, apiBase: "https://x.test", webUrl: "https://x.test", memoryMessage: "m" });
    assert.match(en, /<html lang="en">/);
    assert.match(en, /Connect Claude to Solvers/);
    assert.match(en, /Verified destination/);
    const pt = authorizePage({ lang: "pt", requestId: "ar_1", clientName: "Claude", redirectHost: "claude.ai", verified: true, apiBase: "https://x.test", webUrl: "https://x.test", memoryMessage: "m" });
    assert.match(pt, /<html lang="pt-BR">/);
    assert.match(pt, /Conectar Claude ao Solvers/);
  });

  it("discovers EVM wallets with EIP-6963 and signs with personal_sign (SIWE message from the server)", () => {
    const html = authorizePage({ requestId: "ar_1", clientName: "Claude", redirectHost: "claude.ai", verified: true, apiBase: "https://x.test", webUrl: "https://x.test", memoryMessage: "m" });
    assert.match(html, /eip6963:requestProvider/);
    assert.match(html, /eip6963:announceProvider/);
    assert.match(html, /eth_requestAccounts/);
    assert.match(html, /personal_sign/);
    assert.match(html, /\/oauth\/authorize\/nonce\?/);
    assert.match(html, /location\.host/);
  });

  it("an error escapes HTML and uses the title of the language", () => {
    const html = authorizePage({ error: "<b>x</b>" });
    assert.match(html, /We couldn't continue/);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(authorizePage({ lang: "pt", error: "x" }), /Não foi possível continuar/);
  });

  it("the client name is escaped and the script config cannot close the script tag", () => {
    const html = authorizePage({ requestId: "</script><script>alert(1)</script>", clientName: "<img src=x>", redirectHost: "h", verified: false, apiBase: "https://x.test", webUrl: "https://x.test", memoryMessage: "m" });
    assert.doesNotMatch(html, /<img src=x>/);
    assert.doesNotMatch(html, /<\/script><script>alert/);
  });
});
