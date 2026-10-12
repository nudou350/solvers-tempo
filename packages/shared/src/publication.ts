import { z } from "zod";
import { TxHash, UnitsString } from "./evm.js";
import { AgentStatus } from "./schemas.js";
import { SubmissionStatus } from "./submissions.js";

// On-chain publication contract (PACKAGE_SPEC.md 15): the creator's co-signature, the state of what is missing and the
// admin's completion. Single source for server, api-client and web. No I/O.

/** Publication steps, in order. The first three are creator transactions (routes POST /api/tx/<step>). */
export const PUBLICATION_STEPS = ["register-agent", "update-version", "update-pricing", "await-admin-approval", "ready", "blocked"] as const;
export const PublicationStep = z.enum(PUBLICATION_STEPS);
export type PublicationStep = z.infer<typeof PublicationStep>;

export const CREATOR_SIGNING_STEPS = ["register-agent", "update-version", "update-pricing"] as const;
export type CreatorSigningStep = (typeof CREATOR_SIGNING_STEPS)[number];

/** Body of POST /api/tx/register-agent | /tx/update-version | /tx/update-pricing. No price/hash/name from the client: the server reads the approved record. */
export const PublicationTxInput = z.object({ submissionId: z.string().min(1).max(64) });
export type PublicationTxInput = z.infer<typeof PublicationTxInput>;

/** GET /api/tx/publication/:submissionId: what is missing for the Solver to go live (read from the chain on the spot). */
export const PublicationPlan = z.object({
  submissionId: z.string(),
  status: SubmissionStatus,
  /** Next step. `register-agent`/`update-version`/`update-pricing`: the creator calls POST /api/tx/<step>. */
  step: PublicationStep.nullable(),
  /** Short label of the step (for the screen). */
  label: z.string().nullable(),
  isNewAgent: z.boolean(),
  /** Approved record; `priceUnits` is the price in token base units (decimal string). */
  approved: z.object({ name: z.string(), version: z.string(), priceUnits: UnitsString, royaltyBps: z.number() }).nullable(),
  chain: z.object({
    registered: z.boolean(),
    version: z.string().nullable(),
    priceUnits: UnitsString.nullable(),
    status: AgentStatus.nullable(),
  }),
  /** Only at the `register-agent` step: the stake the Registry pulls from the creator, and the creator's balance. */
  register: z.object({ stakeUnits: UnitsString, balanceUnits: UnitsString, faucetEnabled: z.boolean() }).nullable(),
  error: z.string().nullable(),
});
export type PublicationPlan = z.infer<typeof PublicationPlan>;

/** Body of POST /api/tx/publication/confirm (after the wallet sent the batch): links the tx hash to the submission and advances the flow. */
export const PublicationConfirmInput = z.object({
  submissionId: z.string().min(1).max(64),
  /** Transaction hash: `0x` + 64 hex characters. */
  txHash: TxHash,
  /** The step that was signed (the web knows it). Without it, the hash only fills `register_tx` when that is empty. */
  kind: z.enum(CREATOR_SIGNING_STEPS).optional(),
});
export type PublicationConfirmInput = z.infer<typeof PublicationConfirmInput>;

/** Outcome of the completion (confirm and POST /api/admin/submissions/:id/finish). */
export const FINALIZE_OUTCOMES = ["published", "already_published", "busy", "not_ready", "failed"] as const;
export const PublicationResult = z.object({
  submissionId: z.string(),
  /** Submission status AFTER the call. */
  status: SubmissionStatus,
  outcome: z.enum(FINALIZE_OUTCOMES),
  /** What is still missing (when `not_ready`). */
  step: PublicationStep.nullable(),
  error: z.string().nullable(),
});
export type PublicationResult = z.infer<typeof PublicationResult>;
