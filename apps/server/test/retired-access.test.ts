import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpError } from "../src/lib/http.js";
import {
  agentCanServe,
  agentIsAvailable,
  assertAgentCanServe,
  RETIRED_TEXT,
  servePolicy,
  trialAllowed,
  UNAVAILABLE_TEXT,
  type AccessKind,
} from "../src/runtime/availability.js";

// Retired Solver (on-chain Retired = "retired"): lifetime licenses and open guarantees keep working; the free trial and
// users without access do not. Suspended (chain or platform) cuts everything. Pure rules, no database.

const ok = (status: string, platformStatus = "active") => ({ status, platformStatus });
const KINDS: AccessKind[] = ["license", "guarantee", "trial", "none"];

describe("servePolicy / agentCanServe", () => {
  it("retired with a license or an open guarantee serves", () => {
    assert.equal(servePolicy(ok("retired")), "paid_only");
    assert.equal(agentCanServe(ok("retired"), "license"), true);
    assert.equal(agentCanServe(ok("retired"), "guarantee"), true);
  });

  it("retired without access (none) or on the free trial does not serve", () => {
    assert.equal(agentCanServe(ok("retired"), "none"), false);
    assert.equal(agentCanServe(ok("retired"), "trial"), false);
    assert.equal(trialAllowed(ok("retired")), false);
  });

  it("suspended (chain) never serves, whatever the access", () => {
    for (const k of KINDS) assert.equal(agentCanServe(ok("suspended"), k), false, k);
    assert.equal(servePolicy(ok("suspended")), "closed");
  });

  it("platform suspension (kill switch) cuts even retired and active ones", () => {
    for (const st of ["active", "retired", "suspended", "pending"]) {
      for (const k of KINDS) assert.equal(agentCanServe(ok(st, "suspended"), k), false, `${st}/${k}`);
    }
  });

  it("active serves every access kind; pending and unknown status do not serve", () => {
    for (const k of KINDS) assert.equal(agentCanServe(ok("active"), k), true, k);
    assert.equal(trialAllowed(ok("active")), true);
    for (const st of ["pending", "missing", ""]) for (const k of KINDS) assert.equal(agentCanServe(ok(st), k), false, `${st}/${k}`);
  });
});

describe("storefront and purchase", () => {
  it("retired is not for sale (nor suspended, nor pending); only active with an active platform status", () => {
    assert.equal(agentIsAvailable(ok("retired")), false);
    assert.equal(agentIsAvailable(ok("suspended")), false);
    assert.equal(agentIsAvailable(ok("pending")), false);
    assert.equal(agentIsAvailable(ok("active")), true);
    assert.equal(agentIsAvailable(ok("active", "suspended")), false);
  });
});

describe("assertAgentCanServe", () => {
  const run = (a: ReturnType<typeof ok>, k: AccessKind) => {
    try {
      assertAgentCanServe(a, k);
      return null;
    } catch (e) {
      return e as HttpError;
    }
  };

  it("retired without access: 403 agent_unavailable with the retired text; suspended: the unavailable text", () => {
    const retired = run(ok("retired"), "trial");
    assert.ok(retired instanceof HttpError);
    assert.equal(retired.status, 403);
    assert.equal(retired.code, "agent_unavailable");
    assert.equal(retired.message, RETIRED_TEXT);
    const susp = run(ok("suspended"), "license");
    assert.ok(susp instanceof HttpError);
    assert.equal(susp.message, UNAVAILABLE_TEXT);
  });

  it("retired with a license or guarantee: does not throw", () => {
    assert.equal(run(ok("retired"), "license"), null);
    assert.equal(run(ok("retired"), "guarantee"), null);
  });
});
