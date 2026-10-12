import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertNotPlatformAgent,
  isPlatformAgent,
  isPlatformAgentRow,
  isPlatformPair,
  PLATFORM_AGENTS,
  PLATFORM_AGENT_IDS,
  PLATFORM_NOT_FOR_SALE_CODE,
  platformVerdict,
} from "../src/runtime/platform-agents.js";
import { paidAccessLine } from "../src/runtime/access-rules.js";
import { agentCanServe } from "../src/runtime/availability.js";

// Platform Solvers (PACKAGE_SPEC.md 4.1 and 19): the server list is the authority. No env or database.

const CRIADOR = { slug: "criador-de-solvers", id: "c71ad0a50f750e75c71ad0a50f750e75" };
const OTHER_ID = "0123456789abcdef0123456789abcdef";

describe("PLATFORM_AGENTS", () => {
  it("the Solver Creator is on the list with the fixed contract", () => {
    assert.deepEqual(PLATFORM_AGENTS.find((a) => a.slug === CRIADOR.slug), CRIADOR);
    assert.ok(PLATFORM_AGENT_IDS.includes(CRIADOR.id));
  });

  it("recognizes by id, by slug and by row; anything else is not a platform one", () => {
    assert.equal(isPlatformAgent(CRIADOR.id), true);
    assert.equal(isPlatformAgent(CRIADOR.slug), true);
    assert.equal(isPlatformAgentRow({ id: CRIADOR.id }), true);
    assert.equal(isPlatformAgent(OTHER_ID), false);
    assert.equal(isPlatformAgent("frontend-react"), false);
    assert.equal(isPlatformAgentRow({ id: OTHER_ID }), false);
  });

  it("the slug+id pair must match as a whole", () => {
    assert.equal(isPlatformPair(CRIADOR), true);
    assert.equal(isPlatformPair({ id: CRIADOR.id, slug: "outro-slug" }), false);
    assert.equal(isPlatformPair({ id: OTHER_ID, slug: CRIADOR.slug }), false);
  });
});

describe("platformVerdict: the manifest field only counts if the server agrees", () => {
  it("platform package with the right pair: platform true", () => {
    assert.deepEqual(platformVerdict({ ...CRIADOR, platform: true }, "agents"), { platform: true });
    // The list is the authority: without the field, it is still a platform one.
    assert.deepEqual(platformVerdict(CRIADOR, "agents"), { platform: true });
  });

  it("a regular package in the platform folder (not on the list) is not platform", () => {
    assert.deepEqual(platformVerdict({ id: OTHER_ID, slug: "frontend-react" }, "agents"), { platform: false });
  });

  it("platform: true outside the list is a load error, in both the platform and the creators folder", () => {
    for (const source of ["agents", "published"] as const) {
      const v = platformVerdict({ id: OTHER_ID, slug: "quero-ser-platform", platform: true }, source);
      assert.equal(v.platform, false);
      assert.match(v.error ?? "", /is not in PLATFORM_AGENTS/);
    }
  });

  it("a creator package cannot use the platform slug or id", () => {
    assert.match(platformVerdict(CRIADOR, "published").error ?? "", /can only come from the platform packages folder/);
    assert.match(platformVerdict({ id: OTHER_ID, slug: CRIADOR.slug }, "published").error ?? "", /reserved/);
    assert.match(platformVerdict({ id: CRIADOR.id, slug: "meu-slug" }, "published").error ?? "", /reserved/);
  });

  it("a mismatched pair in the platform folder is refused too", () => {
    assert.match(platformVerdict({ id: CRIADOR.id, slug: "meu-slug" }, "agents").error ?? "", /does not match/);
  });
});

describe("assertNotPlatformAgent", () => {
  it("answers 409 platform_agent_not_for_sale for the platform Solver", () => {
    assert.throws(
      () => assertNotPlatformAgent({ id: CRIADOR.id }),
      (e: unknown) => (e as { status?: number }).status === 409 && (e as { code?: string }).code === PLATFORM_NOT_FOR_SALE_CODE,
    );
    assert.equal(PLATFORM_NOT_FOR_SALE_CODE, "platform_agent_not_for_sale");
  });

  it("does not get in the way of a regular agent", () => {
    assert.doesNotThrow(() => assertNotPlatformAgent({ id: OTHER_ID }));
  });
});

describe("platform access: text and availability", () => {
  it("the access line says it is free, with no license", () => {
    assert.match(paidAccessLine("platform"), /free/);
    assert.match(paidAccessLine("platform"), /platform Solver/);
    assert.match(paidAccessLine("license"), /lifetime license/);
  });

  it("retired still serves platform access (it is not a trial); suspended cuts everything", () => {
    assert.equal(agentCanServe({ status: "active", platformStatus: "active" }, "platform"), true);
    assert.equal(agentCanServe({ status: "retired", platformStatus: "active" }, "platform"), true);
    assert.equal(agentCanServe({ status: "active", platformStatus: "suspended" }, "platform"), false);
    assert.equal(agentCanServe({ status: "retired", platformStatus: "active" }, "trial"), false);
  });
});
