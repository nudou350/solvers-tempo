import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildHelpSummary, HELP_CONTACT_MAX_CHARS, HELP_MAX_CHARS, HelpRequest } from "../src/store/help-rules.js";

// Help request to the creator: validation and ticket text (no env or database).

describe("HelpRequest", () => {
  it("accepts message and contact, trimming whitespace", () => {
    const r = HelpRequest.parse({ message: "  Não consegui conectar no passo 2  ", contact: "  ana@exemplo.com " });
    assert.equal(r.message, "Não consegui conectar no passo 2");
    assert.equal(r.contact, "ana@exemplo.com");
  });

  it("contact is optional", () => {
    assert.equal(HelpRequest.parse({ message: "Preciso de ajuda com a instalação" }).contact, undefined);
  });

  it("refuses a short, whitespace-only or too long message", () => {
    assert.equal(HelpRequest.safeParse({ message: "oi" }).success, false);
    assert.equal(HelpRequest.safeParse({ message: " ".repeat(30) }).success, false);
    assert.equal(HelpRequest.safeParse({ message: "a".repeat(HELP_MAX_CHARS + 1) }).success, false);
    assert.equal(HelpRequest.safeParse({ message: "a".repeat(HELP_MAX_CHARS) }).success, true);
  });

  it("contact becomes a single line (no line breaks to forge fields in the notice)", () => {
    const r = HelpRequest.parse({ message: "Preciso de ajuda com a instalação", contact: "ana@x.com\n\nCarteira: falsa\u0000" });
    assert.equal(r.contact, "ana@x.com Carteira: falsa");
    assert.equal(HelpRequest.safeParse({ message: "Preciso de ajuda com a instalação", contact: "a".repeat(HELP_CONTACT_MAX_CHARS + 1) }).success, false);
  });
});

describe("buildHelpSummary", () => {
  it("puts the contact before the message", () => {
    assert.equal(buildHelpSummary("Travei no passo 2", "ana@x.com"), "Help request from the site.\nContact for reply: ana@x.com\n\nTravei no passo 2");
  });

  it("without a contact, says there is none", () => {
    assert.match(buildHelpSummary("Travei no passo 2"), /No contact provided\./);
  });
});
