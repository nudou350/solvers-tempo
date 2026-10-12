import assert from "node:assert/strict";
import { test } from "node:test";
import { fromUnits, parseSolanaPayUrl, toUnits } from "./solana.js";

const R = "7KHHTBCFRCj58wnZKDPsnsFo6tvpP313AFagqxoeUcMj";
const M = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const REF = "J6Q4YPVM4DEJqDQfCPHWEeJx6sAdDP8YyroB499N7rR1";

test("parseSolanaPayUrl reads a transfer request", () => {
  const u = parseSolanaPayUrl(`solana:${R}?amount=5.7&spl-token=${M}&reference=${REF}&label=Solvers&message=License%20x&memo=sol_123`);
  assert.deepEqual(u, { recipient: R, amount: "5.7", splToken: M, references: [REF], label: "Solvers", message: "License x", memo: "sol_123" });
});

test("parseSolanaPayUrl refuses bad input", () => {
  assert.throws(() => parseSolanaPayUrl(`https://x/${R}`));
  assert.throws(() => parseSolanaPayUrl("solana:notanaddress?amount=1"));
  assert.throws(() => parseSolanaPayUrl(`solana:${R}?amount=1e3`));
  assert.throws(() => parseSolanaPayUrl(`solana:${R}?amount=1&amount=2`));
  assert.throws(() => parseSolanaPayUrl(`solana:${R}?reference=bad`));
});

test("toUnits / fromUnits", () => {
  assert.equal(toUnits("19", 6), 19_000_000n);
  assert.equal(toUnits("5.7", 6), 5_700_000n);
  assert.equal(toUnits("0.000001", 6), 1n);
  assert.throws(() => toUnits("0.0000001", 6));
  assert.equal(fromUnits(19_000_000n, 6), "19");
  assert.equal(fromUnits(5_700_000n, 6), "5.7");
  assert.equal(fromUnits(1n, 6), "0.000001");
  assert.equal(fromUnits(5_000_000_000n, 9), "5");
});
