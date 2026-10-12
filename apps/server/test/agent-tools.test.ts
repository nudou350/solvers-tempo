import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { blockBeforeTrial } from "../src/runtime/access-rules.js";
import { AGENT_CLIENT_ID, isAgentClient } from "../src/oauth/rules.js";
import { AGENT_SERVER_INSTRUCTIONS, AGENT_STEP_NOTE, agentPayEndpoint, agentPurchaseLine, agentPurchaseText, evalLabel, networkText } from "../src/mcp/agent-text.js";

// Agent token: what identifies it (isAgentClient), why there is no free trial (blockBeforeTrial) and its own texts
// (no "show the user" nor checkout link). Pure rules, no database.

const AGENT = "0ee9927a8023c955da8d010762eb2efe";

describe("isAgentClient", () => {
  it("only the fixed client_id of the direct agent login is an agent", () => {
    assert.equal(isAgentClient(AGENT_CLIENT_ID), true);
    assert.equal(isAgentClient("agent"), true);
    for (const c of ["cli_abc123", "Agent", "agent ", "", null, undefined]) assert.equal(isAgentClient(c), false, String(c));
  });
});

describe("blockBeforeTrial", () => {
  const base = { licenseUnknown: false, allowTrial: true, agent: false };

  it("a person with a trial allowed goes on to the trial", () => {
    assert.equal(blockBeforeTrial(base), null);
  });

  it("an agent never reaches the trial (agent_no_trial)", () => {
    assert.equal(blockBeforeTrial({ ...base, agent: true }), "agent_no_trial");
  });

  it("retired Solver: retired (for a person and for an agent)", () => {
    assert.equal(blockBeforeTrial({ ...base, allowTrial: false }), "retired");
    assert.equal(blockBeforeTrial({ ...base, allowTrial: false, agent: true }), "retired");
  });

  it("an unconfirmed license wins: never sends to buy nor spends a trial because of an RPC failure", () => {
    assert.equal(blockBeforeTrial({ licenseUnknown: true, allowTrial: true, agent: false }), "unverified");
    assert.equal(blockBeforeTrial({ licenseUnknown: true, allowTrial: false, agent: true }), "unverified");
  });
});

describe("performance score label (P5)", () => {
  it("no score: no ratings yet, never 0% nor verified", () => {
    assert.equal(evalLabel(0), "performance: no ratings yet");
    assert.doesNotMatch(evalLabel(0), /0%|verified/i);
  });
  it("with a score: internal team test, never verified", () => {
    assert.equal(evalLabel(8250), "internal team test (automated checks): 83%");
    assert.doesNotMatch(evalLabel(8250), /verified/i);
  });
});

describe("agent texts", () => {
  const p = { apiBase: "https://solvers.example.com", agentId: AGENT, name: "Solver X", price: "12.5", symbol: "USD", network: networkText(42431) };

  it("networkText: Tempo label and chain id", () => {
    assert.equal(networkText(42431), "Tempo Testnet (chain 42431)");
    assert.equal(networkText(4217), "Tempo (chain 4217)");
  });

  it("purchase instructions: MPP endpoint, 402, price, network and next step", () => {
    const t = agentPurchaseText(p);
    const endpoint = `https://solvers.example.com/api/agent-pay/solvers/${AGENT}/license`;
    assert.equal(agentPayEndpoint(p.apiBase, AGENT), endpoint);
    assert.ok(t.includes(`POST ${endpoint}`));
    assert.match(t, /402/);
    assert.match(t, /WWW-Authenticate: Payment/);
    assert.match(t, /Authorization: Payment/);
    assert.ok(t.includes("Tempo Testnet (chain 42431)"));
    assert.ok(t.includes("12.5 USD"));
    assert.match(t, /activate_solver again/);
  });

  it("no agent text tells to show the user or uses the checkout, nor names the previous payment flow", () => {
    for (const t of [agentPurchaseText(p), agentPurchaseLine(p), AGENT_SERVER_INSTRUCTIONS, AGENT_STEP_NOTE]) {
      assert.doesNotMatch(t, /\/checkout/);
      assert.doesNotMatch(t, /show (the )?(link )?to the user|show the link/i);
      assert.doesNotMatch(t, /x402|PAYMENT-SIGNATURE|USDC/);
    }
  });

  it("the step header tells the agent to decide from context and record the assumption", () => {
    assert.match(AGENT_STEP_NOTE, /autonomous agent/);
    assert.match(AGENT_STEP_NOTE, /result_summary/);
  });

  it("the connector instructions say there is no free trial", () => {
    assert.match(AGENT_SERVER_INSTRUCTIONS, /no free trial/);
  });
});

describe("agent texts with agent payments off (AGENT_PAY_ENABLED=false)", () => {
  it("checkout link instead of the agent-pay endpoint; instructions without HTTP 402", async () => {
    const { agentCheckoutLine, agentCheckoutText, agentServerInstructions } = await import("../src/mcp/agent-text.js");
    const link = "https://solvers.example.com/checkout?agent=solver-x&type=permanent";
    const t = agentCheckoutText({ name: "Solver X", price: "12.5", symbol: "USD", network: networkText(42431), link });
    assert.ok(t.includes(link));
    assert.match(t, /not enabled/);
    assert.match(t, /activate_solver again/);
    for (const s of [t, agentCheckoutLine({ price: "12.5", symbol: "USD", link }), agentServerInstructions(false)]) {
      assert.doesNotMatch(s, /\/api\/agent-pay|WWW-Authenticate|Authorization: Payment/);
      assert.doesNotMatch(s, /show (the )?(link )?to the user|show the link/i);
    }
    assert.doesNotMatch(agentServerInstructions(false), /402/);
    assert.match(agentServerInstructions(true), /HTTP 402/);
    assert.equal(agentServerInstructions(true), AGENT_SERVER_INSTRUCTIONS);
  });
});
