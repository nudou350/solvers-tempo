import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agentMirrorValues, type AgentChainState } from "../src/indexer/mirror.js";
import { AGENT_ID_RE, isAgentId, slugProblem, versionProblem } from "../src/runtime/agent-ids.js";
import { agentIsAvailable, assertAgentAvailable, PLATFORM_ACTIVE, PLATFORM_SUSPENDED } from "../src/runtime/availability.js";
import { canUseMemory } from "../src/runtime/memory-access.js";
import { HttpError } from "../src/lib/http.js";

// Platform kill switch, memory access and id format (PACKAGE_SPEC.md 11.2, 15.4 and P0). Pure: no database.

describe("availability: on-chain status AND platform suspension", () => {
  it("serves and sells only with both active", () => {
    assert.equal(agentIsAvailable({ status: "active", platformStatus: PLATFORM_ACTIVE }), true);
    assert.equal(agentIsAvailable({ status: "active", platformStatus: PLATFORM_SUSPENDED }), false);
    assert.equal(agentIsAvailable({ status: "suspended", platformStatus: PLATFORM_ACTIVE }), false);
    assert.equal(agentIsAvailable({ status: "pending", platformStatus: PLATFORM_ACTIVE }), false);
    assert.equal(agentIsAvailable({ status: "active", platformStatus: "anything-else" }), false);
  });

  it("assertAgentAvailable: 403 agent_unavailable when suspended", () => {
    assert.doesNotThrow(() => assertAgentAvailable({ status: "active", platformStatus: "active" }));
    assert.throws(
      () => assertAgentAvailable({ status: "active", platformStatus: "suspended" }),
      (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === "agent_unavailable",
    );
  });
});

describe("indexer: the platform suspension survives the chain mirror", () => {
  // Minimal on-chain state (only what the mirror reads).
  const state = (status: number): AgentChainState => ({
    agentId: "0123456789abcdef0123456789abcdef",
    view: {
      creator: "0x00000000000000000000000000000000000000c1",
      status,
      royaltyBps: 500,
      totalSales: 3,
      maxSupply: 0,
      price: 5_000_000n,
      pricePerUse: 0n,
      disputesLost: 0,
      index: 0,
      stake: 0n,
      versionHash: `0x${"01".repeat(32)}`,
      version: "1.0.0",
    },
    eval: { measured: true, scoreBps: 8000, evalHash: `0x${"02".repeat(32)}` },
    rating: { sum: 20n, count: 5 },
    verifiedUses: 0n,
  });

  it("the values the indexer writes have NO platformStatus (for any status)", () => {
    for (const status of [0, 1, 2, 3]) {
      const values = agentMirrorValues(state(status));
      assert.equal("platformStatus" in values, false, `on-chain status ${status}`);
      assert.equal("platform_status" in values, false);
    }
  });

  it("the mirror still reflects the on-chain status", () => {
    assert.equal(agentMirrorValues(state(0)).status, "pending");
    assert.equal(agentMirrorValues(state(1)).status, "active");
    assert.equal(agentMirrorValues(state(2)).status, "suspended");
    assert.equal(agentMirrorValues(state(3)).status, "retired", "Retired (3) is mirrored as retired (not as suspended)");
    assert.equal(agentMirrorValues(state(9)).status, "pending");
  });

  it("scenario: suspended by the platform, a chain event re-activates status but the agent stays unavailable", () => {
    // Database row: mirrored status "active" and platformStatus "suspended" (kill switch).
    let row = { status: "active", platformStatus: PLATFORM_SUSPENDED };
    // A usage or purchase event: the indexer applies the mirror (without platformStatus).
    row = { ...row, ...agentMirrorValues(state(1)) };
    assert.equal(row.platformStatus, PLATFORM_SUSPENDED);
    assert.equal(agentIsAvailable(row), false);
  });
});

describe("memory: only with a license or an open session", () => {
  it("access rule", () => {
    assert.equal(canUseMemory({ licensed: false, openSession: false }), false);
    assert.equal(canUseMemory({ licensed: true, openSession: false }), true);
    assert.equal(canUseMemory({ licensed: false, openSession: true }), true);
    assert.equal(canUseMemory({ licensed: true, openSession: true }), true);
  });
});

describe("ids and slugs", () => {
  it("isAgentId: 32 lowercase hex", () => {
    assert.equal(isAgentId("0123456789abcdef0123456789abcdef"), true);
    assert.equal(isAgentId("0123456789ABCDEF0123456789abcdef"), false);
    assert.equal(isAgentId("frontend-react"), false);
    assert.equal(isAgentId("0123456789abcdef0123456789abcde"), false);
    assert.equal(AGENT_ID_RE.test("g123456789abcdef0123456789abcdef"), false);
  });

  it("slugProblem explains the reason", () => {
    assert.equal(slugProblem("frontend-react"), null);
    assert.match(slugProblem("0123456789abcdef0123456789abcdef")!, /format of an id/);
    assert.match(slugProblem("Ab")!, /3 to 40/);
    assert.match(slugProblem("With Space")!, /lowercase/);
  });

  it("versionProblem: numeric, no pre-release, up to 16 bytes", () => {
    assert.equal(versionProblem("1.2.3"), null);
    assert.match(versionProblem("1.2")!, /MAJOR\.MINOR\.PATCH/);
    assert.match(versionProblem("1.2.3-rc1")!, /MAJOR\.MINOR\.PATCH/);
    assert.match(versionProblem("1234567.1234567.12345")!, /16 bytes/);
  });
});
