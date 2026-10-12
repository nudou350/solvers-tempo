import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpError } from "../src/lib/http.js";
import { assertSessionCurrent, licenseRecheckDue, planNextStep, withSummary } from "../src/runtime/session-rules.js";

// Pure rules of the connector sessions (no env or database).

describe("assertSessionCurrent", () => {
  it("same version passes; a different version asks for a new activation (409)", () => {
    assert.doesNotThrow(() => assertSessionCurrent("1.0.0", "1.0.0", "X"));
    assert.throws(
      () => assertSessionCurrent("1.0.0", "1.1.0", "Especialista X"),
      (e: unknown) => e instanceof HttpError && e.status === 409 && /Especialista X was updated.*activate_solver/.test(e.message),
    );
  });
});

describe("planNextStep (completed_step)", () => {
  it("no completed_step: advances as before (backward compatible)", () => {
    assert.deepEqual(planNextStep(0), { kind: "advance", index: 0 });
    assert.deepEqual(planNextStep(3), { kind: "advance", index: 3 });
  });

  it("equal to the steps delivered: advances", () => {
    assert.deepEqual(planNextStep(0, 0), { kind: "advance", index: 0 });
    assert.deepEqual(planNextStep(2, 2), { kind: "advance", index: 2 });
  });

  it("lower: resends the step without advancing", () => {
    assert.deepEqual(planNextStep(2, 1), { kind: "replay", index: 1 });
    assert.deepEqual(planNextStep(1, 0), { kind: "replay", index: 0 });
  });

  it("higher: badRequest", () => {
    assert.throws(() => planNextStep(1, 2), (e: unknown) => e instanceof HttpError && e.status === 400);
  });

  it("lost reply: the retry does not skip a step", () => {
    // Simulated session: stepIndex = steps delivered.
    let stepIndex = 0;
    const call = (completed?: number) => {
      const plan = planNextStep(stepIndex, completed);
      if (plan.kind === "advance") stepIndex += 1;
      return plan.index;
    };
    assert.equal(call(0), 0); // step 1 delivered
    assert.equal(call(1), 1); // step 2 delivered, but the reply is lost
    assert.equal(call(1), 1); // retry: step 2 again, without advancing
    assert.equal(stepIndex, 2);
    assert.equal(call(2), 2); // the AI moves on to step 3
  });
});

describe("withSummary", () => {
  it("writes the right slot without touching the others or the rest of the context", () => {
    const ctx = { escrowId: "E1", summaries: ["a"] };
    const out = withSummary(ctx, 1, "b");
    assert.deepEqual(out, { escrowId: "E1", summaries: ["a", "b"] });
    assert.deepEqual(ctx.summaries, ["a"]);
  });

  it("a negative slot writes nothing; cuts at 4000 characters", () => {
    assert.deepEqual(withSummary({}, -1, "x"), { summaries: [] });
    assert.equal((withSummary({}, 0, "y".repeat(5000)).summaries as string[])[0]!.length, 4000);
  });
});

describe("licenseRecheckDue", () => {
  it("rechecks the first time and after the window; reuses within it", () => {
    assert.equal(licenseRecheckDue(undefined, 1000), true);
    assert.equal(licenseRecheckDue(1000, 1000 + 44_000), false);
    assert.equal(licenseRecheckDue(1000, 1000 + 45_000), true);
    assert.equal(licenseRecheckDue(5000, 1000), true); // the clock went back
  });
});
