import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_STATUS,
  ALL_PAUSE_FLAGS,
  ESCROW_STATUS,
  MILESTONE_STATUS,
  PAUSE_FLAGS,
  PURCHASE_KIND,
  agentStatusName,
  escrowStatusName,
  isPaused,
  milestoneStatusName,
  purchaseKindCode,
  purchaseKindName,
} from "./onchain.js";
import { AgentStatus, EscrowStatus, MilestoneStatus } from "./schemas.js";

test("enum values mirror the contracts", () => {
  assert.deepEqual(AGENT_STATUS, { Pending: 0, Active: 1, Suspended: 2, Retired: 3 });
  assert.deepEqual(MILESTONE_STATUS, { Pending: 0, Passed: 1, Approved: 2, Disputed: 3, Refunded: 4 });
  assert.deepEqual(ESCROW_STATUS, { Active: 0, Completed: 1, Disputed: 2, Refunded: 3 });
  assert.deepEqual(PAUSE_FLAGS, { ENTRIES: 1, PAYMENTS: 2, TRANSFERS: 4 });
  assert.equal(ALL_PAUSE_FLAGS, 7);
  assert.deepEqual(PURCHASE_KIND, { License: 1, Credits: 2, Escrow: 3 });
});

test("code -> API name, and every name is a valid API enum value", () => {
  assert.deepEqual([0, 1, 2, 3].map(agentStatusName), ["pending", "active", "suspended", "retired"]);
  assert.deepEqual([0, 1, 2, 3, 4].map(milestoneStatusName), ["pending", "passed", "approved", "disputed", "refunded"]);
  assert.deepEqual([0, 1, 2, 3].map(escrowStatusName), ["active", "approved", "disputed", "refunded"]);
  for (const n of [0, 1, 2, 3]) assert.ok(AgentStatus.safeParse(agentStatusName(n)).success);
  for (const n of [0, 1, 2, 3, 4]) assert.ok(MilestoneStatus.safeParse(milestoneStatusName(n)).success);
  for (const n of [0, 1, 2, 3]) assert.ok(EscrowStatus.safeParse(escrowStatusName(n)).success);
  for (const bad of [-1, 4, 1.5]) assert.throws(() => agentStatusName(bad), RangeError);
  assert.throws(() => milestoneStatusName(5), RangeError);
  assert.throws(() => escrowStatusName(4), RangeError);
});

test("purchase kinds round-trip", () => {
  for (const code of [1, 2, 3]) assert.equal(purchaseKindCode(purchaseKindName(code)), code);
  assert.equal(purchaseKindName(PURCHASE_KIND.Escrow), "escrow");
  assert.throws(() => purchaseKindName(0), RangeError);
  assert.throws(() => purchaseKindName(4), RangeError);
});

test("pause bits", () => {
  assert.equal(isPaused(0, PAUSE_FLAGS.ENTRIES), false);
  assert.equal(isPaused(PAUSE_FLAGS.ENTRIES, PAUSE_FLAGS.ENTRIES), true);
  assert.equal(isPaused(PAUSE_FLAGS.ENTRIES, PAUSE_FLAGS.TRANSFERS), false);
  assert.equal(isPaused(ALL_PAUSE_FLAGS, PAUSE_FLAGS.PAYMENTS), true);
  assert.equal(isPaused(PAUSE_FLAGS.PAYMENTS | PAUSE_FLAGS.TRANSFERS, PAUSE_FLAGS.TRANSFERS), true);
});
