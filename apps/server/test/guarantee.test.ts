import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { guaranteesText, guaranteeTaskText, milestoneDeliveryBlock, resolveEscrowId, splitCriteria, type GuaranteeTask } from "../src/runtime/guarantee-text.js";
import {
  cancelUndeliveredBlock,
  canCancelUndelivered,
  DEFAULT_DELIVERY_DAYS,
  deliveryDeadlineFrom,
  deliveryIntact,
  disputeDeadlineOf,
  DISPUTE_SLA_SECS,
  MAX_DELIVERY_DAYS,
  resolveDeliveryDays,
} from "../src/store/delivery-rules.js";

// Guaranteed-task context on activation and the escrow_id rule (no env or database).

const task = (id: string, title = "Formulário de login"): GuaranteeTask => ({
  id,
  agentId: "a1",
  title,
  description: "Preciso de um formulário com e-mail e senha.",
  deliveryDeadline: new Date("2099-01-15T12:00:00Z"),
  milestones: [
    { idx: 1, title: "Componente", criteria: "Valida e-mail; mostra erro", verify: "tests", status: "pending", amount: 12_000_000n },
    { idx: 0, title: "Plano", criteria: "Lista de casos de teste", verify: "manual", status: "passed", amount: 3_000_000n },
  ],
});

describe("guaranteeTaskText", () => {
  it("includes escrow_id, title, briefing, steps in order and criteria", () => {
    const t = guaranteeTaskText(task("ESC1"));
    assert.match(t, /escrow_id: ESC1/);
    assert.match(t, /Formulário de login/);
    assert.match(t, /Preciso de um formulário/);
    assert.ok(t.indexOf("milestone=0") < t.indexOf("milestone=1"));
    assert.match(t, /Step 1 \(milestone=0\): Plano \[manual review; 3 USD; passed the check/);
    assert.match(t, /\* Valida e-mail/);
    assert.match(t, /\* mostra erro/);
  });

  it("splitCriteria splits on newlines and semicolons", () => {
    assert.deepEqual(splitCriteria("a; b\nc\n\n"), ["a", "b", "c"]);
  });
});

describe("guaranteesText", () => {
  it("empty without tasks; a single one without a warning", () => {
    assert.equal(guaranteesText([]), "");
    const one = guaranteesText([task("ESC1")]);
    assert.match(one, /escrow_id: ESC1/);
    assert.doesNotMatch(one, /ATENÇÃO/);
  });

  it("more than one: a warning to pass the escrow_id and the details of all of them", () => {
    const t = guaranteesText([task("ESC1", "Primeira"), task("ESC2", "Segunda")]);
    assert.match(t, /ATTENTION.*2 open guaranteed tasks.*escrow_id/);
    assert.match(t, /escrow_id: ESC1/);
    assert.match(t, /escrow_id: ESC2/);
    assert.match(t, /Primeira/);
    assert.match(t, /Segunda/);
  });
});

describe("resolveEscrowId (submit_deliverable)", () => {
  const A = task("A", "Tarefa A");
  const B = task("B", "Tarefa B");

  it("only one open: omitted uses it; the same id given passes", () => {
    assert.deepEqual(resolveEscrowId({ sessionEscrowId: "A", open: [A] }), { escrowId: "A", rebind: false });
    assert.deepEqual(resolveEscrowId({ sessionEscrowId: "A", given: "A", open: [A] }), { escrowId: "A", rebind: false });
    assert.deepEqual(resolveEscrowId({ open: [A] }), { escrowId: "A", rebind: false });
  });

  it("session bound to A, B is the only open one and the AI omits it: uses B and rebinds the session", () => {
    assert.deepEqual(resolveEscrowId({ sessionEscrowId: "A", open: [B] }), { escrowId: "B", rebind: true });
  });

  it("more than one open: an omitted id is an error listing the tasks (never uses the session's)", () => {
    assert.throws(
      () => resolveEscrowId({ sessionEscrowId: "A", open: [B, A] }),
      (e: unknown) => e instanceof Error && /2 open guaranteed tasks/.test(e.message) && /Tarefa A \(escrow_id: A\)/.test(e.message) && /Tarefa B \(escrow_id: B\)/.test(e.message),
    );
    assert.throws(() => resolveEscrowId({ open: [A, B] }), /pass the escrow_id/);
  });

  it("a given id among the open ones is accepted, even with the session bound to another (rebinds the session)", () => {
    assert.deepEqual(resolveEscrowId({ sessionEscrowId: "A", given: "B", open: [B, A] }), { escrowId: "B", rebind: true });
    assert.deepEqual(resolveEscrowId({ sessionEscrowId: "A", given: "A", open: [B, A] }), { escrowId: "A", rebind: false });
  });

  it("license session (no escrowId in the session): gives it or uses the only one, without rebinding", () => {
    assert.deepEqual(resolveEscrowId({ given: "B", open: [B, A] }), { escrowId: "B", rebind: false });
    assert.deepEqual(resolveEscrowId({ open: [B] }), { escrowId: "B", rebind: false });
  });

  it("an id outside the open ones is refused; with none open as well", () => {
    assert.throws(() => resolveEscrowId({ given: "X", open: [A] }), /not among this specialist's open tasks/);
    assert.throws(() => resolveEscrowId({ given: "X", open: [] }), /is not open/);
    assert.throws(() => resolveEscrowId({ open: [] }), /has no open guaranteed task/);
  });
});

describe("deliveryIntact (download of the approved delivery)", () => {
  it("only allows it with files and a hash equal to the approved one", () => {
    assert.equal(deliveryIntact(2, "abc", "abc"), true);
    assert.equal(deliveryIntact(2, "abc", "abd"), false);
    assert.equal(deliveryIntact(0, "abc", "abc"), false);
    assert.equal(deliveryIntact(2, "abc", null), false);
  });
});

describe("delivery deadline in the AI text", () => {
  it("shows the deadline; overdue warns but blocks nothing; no deadline (old task) shows nothing", () => {
    assert.match(guaranteeTaskText(task("E")), /Delivery deadline: 2099-01-15/);
    assert.doesNotMatch(guaranteeTaskText(task("E")), /OVERDUE/);
    assert.match(guaranteeTaskText({ ...task("E"), deliveryDeadline: new Date("2020-01-01T00:00:00Z") }), /OVERDUE/);
    assert.doesNotMatch(guaranteeTaskText({ ...task("E"), deliveryDeadline: null }), /Delivery deadline/);
  });
});

describe("milestoneDeliveryBlock", () => {
  it("a canceled/refunded or nonexistent step is refused with a clear message; the rest goes on (the contract decides the deadline)", () => {
    const t = { ...task("E"), milestones: [...task("E").milestones, { idx: 2, title: "Extra", criteria: "x", verify: "tests", status: "refunded", amount: 1n }] };
    assert.match(milestoneDeliveryBlock(t, 2)!, /canceled or refunded/);
    assert.match(milestoneDeliveryBlock(t, 4)!, /has no step/);
    assert.equal(milestoneDeliveryBlock(t, 1), null);
    assert.equal(milestoneDeliveryBlock({ ...t, deliveryDeadline: new Date("2020-01-01T00:00:00Z") }, 1), null);
  });
});

describe("resolveDeliveryDays", () => {
  it("missing or 0 means 14; 1 to 60 pass", () => {
    assert.equal(resolveDeliveryDays(undefined), DEFAULT_DELIVERY_DAYS);
    assert.equal(resolveDeliveryDays(0), 14);
    assert.equal(resolveDeliveryDays(1), 1);
    assert.equal(resolveDeliveryDays(MAX_DELIVERY_DAYS), 60);
  });
  it("61, negative and fractional are refused with an English message", () => {
    for (const d of [61, -1, 2.5, Number.NaN]) assert.throws(() => resolveDeliveryDays(d), /between 1 and 60 days/);
  });
  it("deliveryDeadlineFrom adds days", () => {
    assert.equal(deliveryDeadlineFrom(new Date("2026-01-01T00:00:00Z"), 14).toISOString(), "2026-01-15T00:00:00.000Z");
  });
});

describe("dispute and cancellation for late delivery", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const past = new Date("2026-01-20T00:00:00Z");
  const future = new Date("2026-02-10T12:00:00Z");

  it("disputeDeadline: null without a dispute or if the step already passed the tests (only the admin rules)", () => {
    assert.equal(DISPUTE_SLA_SECS, 7 * 86400);
    assert.equal(disputeDeadlineOf({ disputedAt: null, passedAt: null }, past), null);
    assert.equal(disputeDeadlineOf({ disputedAt: new Date("2026-01-01T00:00:00Z"), passedAt: new Date("2025-12-31T00:00:00Z") }, past), null);
  });

  it("disputeDeadline: a step that never passed = the later of disputedAt + 7 days and the delivery deadline", () => {
    const disputedAt = new Date("2026-01-01T00:00:00Z");
    // delivery deadline before the SLA: disputedAt + 7 days applies
    assert.equal(disputeDeadlineOf({ disputedAt, passedAt: null }, new Date("2025-12-30T00:00:00Z"))!.toISOString(), "2026-01-08T00:00:00.000Z");
    // delivery deadline after the SLA: the delivery deadline applies
    assert.equal(disputeDeadlineOf({ disputedAt, passedAt: null }, new Date("2026-01-20T00:00:00Z"))!.toISOString(), "2026-01-20T00:00:00.000Z");
    // old task without a delivery deadline: only the SLA
    assert.equal(disputeDeadlineOf({ disputedAt, passedAt: null }, null)!.toISOString(), "2026-01-08T00:00:00.000Z");
  });

  it("canCancelUndelivered: pending step, open task and deadline passed", () => {
    assert.equal(canCancelUndelivered({ closed: false, deliveryDeadline: past }, { status: "pending" }, now), true);
    assert.equal(canCancelUndelivered({ closed: false, deliveryDeadline: future }, { status: "pending" }, now), false);
    assert.equal(canCancelUndelivered({ closed: false, deliveryDeadline: past }, { status: "passed" }, now), false);
    assert.equal(canCancelUndelivered({ closed: true, deliveryDeadline: past }, { status: "pending" }, now), false);
    assert.equal(canCancelUndelivered({ closed: false, deliveryDeadline: null }, { status: "pending" }, now), false);
  });

  it("cancelUndeliveredBlock: null when allowed; clear messages (with the date) when not", () => {
    assert.equal(cancelUndeliveredBlock({ closed: false, deliveryDeadline: past }, { status: "pending" }, now), null);
    assert.match(cancelUndeliveredBlock({ closed: false, deliveryDeadline: future }, { status: "pending" }, now)!, /only passes on 2026-02-10/);
    assert.match(cancelUndeliveredBlock({ closed: false, deliveryDeadline: past }, { status: "submitted" }, now)!, /hasn't been delivered yet/);
    assert.match(cancelUndeliveredBlock({ closed: true, deliveryDeadline: past }, { status: "pending" }, now)!, /already closed/);
    assert.match(cancelUndeliveredBlock({ closed: false, deliveryDeadline: null }, { status: "pending" }, now)!, /without a delivery deadline/);
  });
});

describe("guaranteeTaskText: placeholder steps (texts not recorded yet)", () => {
  it("a step without criteria says so and never claims automated tests", () => {
    const t = guaranteeTaskText({ ...task("ESC9"), milestones: [{ idx: 0, title: "Step 1", criteria: "", verify: "tests", status: "pending", amount: 6_000_000n }] });
    assert.match(t, /milestone=0\): agreed criteria not recorded yet/);
    assert.doesNotMatch(t, /automated tests/);
  });
});
