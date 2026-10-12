import { DEFAULT_TOKEN_DECIMALS, unitsToNumber } from "@solvers/shared";
import { badRequest } from "../lib/http.js";
import { formatDeadline } from "../store/delivery-rules.js";

// Guaranteed-task context the connector hands to the AI (activate_solver, list_open_guarantees)
// and the escrow_id rule of submit_deliverable. Pure functions (no env/database), tested in test/guarantee.test.ts.

export type GuaranteeTask = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  /** Delivery deadline (null for tasks created before the v2 contract). */
  deliveryDeadline: Date | null;
  milestones: { idx: number; title: string; criteria: string; verify: string; status: string; amount: bigint }[];
};

/** Agreed criteria of a step, one per item. */
export function splitCriteria(criteria: string): string[] {
  return criteria
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STATUS_LABEL: Record<string, string> = {
  pending: "waiting for delivery",
  submitted: "delivery being checked",
  passed: "passed the check, waiting for the user",
  approved: "approved",
  disputed: "in dispute",
  refunded: "canceled or refunded (no longer accepts deliveries)",
};

function deadlineLines(t: GuaranteeTask): string[] {
  if (!t.deliveryDeadline) return [];
  const late = Date.now() > t.deliveryDeadline.getTime();
  return [
    `Delivery deadline: ${formatDeadline(t.deliveryDeadline)}${late ? " (OVERDUE: deliver as soon as possible; the user can already cancel the pending steps and get a refund)" : ""}.`,
    "",
  ];
}

/** Why a step does not accept a delivery (null: go ahead; the verifier and the contract decide the rest, including an overdue deadline). */
export function milestoneDeliveryBlock(t: GuaranteeTask, index: number): string | null {
  const m = t.milestones.find((x) => x.idx === index);
  if (!m) return `The task "${t.title}" has no step with milestone=${index}.`;
  if (m.status === "refunded") return `Step ${index + 1} of this task was canceled or refunded and no longer accepts deliveries.`;
  return null;
}

/** Text block with what is needed to do the task and deliver it (escrow_id, briefing, steps and criteria). */
export function guaranteeTaskText(t: GuaranteeTask): string {
  const lines = [`## Guaranteed task: ${t.title}`, `escrow_id: ${t.id}`, "", "User briefing:", t.description.trim() || "(no description)", "", ...deadlineLines(t), "Agreed steps (deliver each one with submit_deliverable):"];
  for (const m of [...t.milestones].sort((a, b) => a.idx - b.idx)) {
    const criteria = splitCriteria(m.criteria);
    if (criteria.length === 0) {
      // Placeholder row (texts not copied from the purchase record yet): the verify mode is unknown and no delivery is checked.
      lines.push(`- Step ${m.idx + 1} (milestone=${m.idx}): agreed criteria not recorded yet; deliveries for it are not checked until they are [${STATUS_LABEL[m.status] ?? m.status}]`);
      continue;
    }
    lines.push(`- Step ${m.idx + 1} (milestone=${m.idx}): ${m.title} [${m.verify === "manual" ? "manual review" : "automated tests"}; ${unitsToNumber(m.amount, DEFAULT_TOKEN_DECIMALS)} USD; ${STATUS_LABEL[m.status] ?? m.status}]`);
    for (const c of criteria) lines.push(`    * ${c}`);
  }
  return lines.join("\n");
}

/** One line per task: so the AI (or the user) can pick which one it is. */
export function guaranteeChoices(tasks: GuaranteeTask[]): string {
  return tasks.map((t) => `- ${t.title} (escrow_id: ${t.id})`).join("\n");
}

/**
 * The specialist's open guarantees as text. With more than one, all of them in detail (the AI needs to know what
 * each one asks for) plus the rule: pass the escrow_id to submit_deliverable.
 */
export function guaranteesText(tasks: GuaranteeTask[]): string {
  if (tasks.length === 0) return "";
  if (tasks.length === 1) return guaranteeTaskText(tasks[0]!);
  return [
    `ATTENTION: the user has ${tasks.length} open guaranteed tasks with this specialist. Find out with them which one this conversation is about (by title, never ask for the id) and always pass its escrow_id to submit_deliverable.`,
    "",
    tasks.map(guaranteeTaskText).join("\n\n"),
  ].join("\n");
}

export type EscrowChoice = {
  escrowId: string;
  /** The guarantee session's escrow_id changed: store the new one in the session context. */
  rebind: boolean;
};

/**
 * escrow_id of submit_deliverable, over the user's open guarantees with the specialist (`open`).
 * - given: must be among the open ones (accepted even if the session is bound to another; then the session's is swapped);
 * - omitted with more than one open: error listing the tasks (never guesses);
 * - omitted with only one: that one (the guarantee session now points to it if it was on another);
 * - none open: error.
 */
export function resolveEscrowId(input: { sessionEscrowId?: unknown; given?: string; open: GuaranteeTask[] }): EscrowChoice {
  const fromSession = typeof input.sessionEscrowId === "string" ? input.sessionEscrowId : undefined;
  const { open, given } = input;
  const choose = (escrowId: string): EscrowChoice => ({ escrowId, rebind: !!fromSession && fromSession !== escrowId });
  if (given) {
    if (!open.some((t) => t.id === given)) {
      throw badRequest(
        open.length === 0
          ? "This guaranteed task is not open for this specialist."
          : `This guaranteed task is not among this specialist's open tasks. Open tasks:\n${guaranteeChoices(open)}`,
      );
    }
    return choose(given);
  }
  if (open.length === 0) throw badRequest("The user has no open guaranteed task with this specialist.");
  if (open.length > 1) {
    throw badRequest(`There are ${open.length} open guaranteed tasks: pass the escrow_id of the right one (confirm with the user by title).\n${guaranteeChoices(open)}`);
  }
  return choose(open[0]!.id);
}
