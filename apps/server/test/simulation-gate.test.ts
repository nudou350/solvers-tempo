import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { encodeErrorResult, ExecutionRevertedError, HttpRequestError } from "viem";
import { solversAbi } from "@solvers/contracts-client";
import { HttpError } from "../src/lib/http.js";
import { assertSimulationOk, classifySimulationError, type SimulationResult } from "../src/store/simulation-gate.js";

// Simulation before the signature: only a contract revert refuses; the rest does not block (fail-open) and is logged.

const run = (r: SimulationResult) => {
  const logs: string[] = [];
  let thrown: unknown = null;
  try {
    assertSimulationOk(r, "purchase", (m) => logs.push(m));
  } catch (e) {
    thrown = e;
  }
  return { thrown, logs };
};

describe("assertSimulationOk", () => {
  it("ok simulation: continues without a log", () => {
    assert.deepEqual(run({ ok: true, gas: 1n }), { thrown: null, logs: [] });
  });

  it("contract error: 409 operation_rejected with the friendly message (never 422, which the web reads as a network failure)", () => {
    const { thrown, logs } = run({ ok: false, kind: "rejected", name: "AgentNotActive", message: "This Solver is not available for sale right now." });
    assert.ok(thrown instanceof HttpError);
    assert.equal(thrown.status, 409);
    assert.equal(thrown.code, "operation_rejected");
    assert.equal(thrown.message, "This Solver is not available for sale right now.");
    assert.deepEqual(thrown.extra, { contractError: "AgentNotActive" });
    assert.deepEqual(logs, []);
  });

  it("SoldOut: 409 sold_out, the same code as the precheck, so the screen shows Sold out", () => {
    const { thrown } = run({ ok: false, kind: "rejected", name: "SoldOut", message: "This Solver is sold out." });
    assert.ok(thrown instanceof HttpError);
    assert.equal(thrown.status, 409);
    assert.equal(thrown.code, "sold_out");
  });

  it("RPC down/timeout: fail-open, logged", () => {
    const { thrown, logs } = run({ ok: false, kind: "infra", message: "fetch failed" });
    assert.equal(thrown, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /purchase.*unavailable.*fetch failed/);
  });
});

describe("classifySimulationError", () => {
  it("a custom error in the revert data is rejected with its name", () => {
    const data = encodeErrorResult({ abi: solversAbi, errorName: "SoldOut", args: [`0x${"ab".repeat(16)}${"0".repeat(32)}`, 3] });
    const r = classifySimulationError(data);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.kind === "rejected" && r.name === "SoldOut");
  });

  it("an explicit revert without data is rejected (Unknown); a transport error is infra", () => {
    const reverted = classifySimulationError(new ExecutionRevertedError({ message: "execution reverted" }));
    assert.ok(!reverted.ok && reverted.kind === "rejected" && reverted.name === "Unknown");
    const infra = classifySimulationError(new HttpRequestError({ url: "http://127.0.0.1:1", details: "fetch failed" }));
    assert.ok(!infra.ok && infra.kind === "infra");
  });
});
