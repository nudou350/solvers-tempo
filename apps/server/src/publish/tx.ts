import { and, eq, inArray, ne } from "drizzle-orm";
import type { CreatorSigningStep, PublicationConfirmInput, PublicationPlan, PublicationResult, SubmissionStatus, TxResponse } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError, badRequest, forbidden, notFound } from "../lib/http.js";
import {
  SIGNABLE_STATUSES,
  STEP_LABEL,
  STEP_TO_TOUCH,
  approvedPriceUnits,
  maxSupplyOf,
  nextPublicationStep,
  parseApproved,
  royaltyProblem,
  stepMismatch,
  type ChainAgentState,
  type PublicationStep,
} from "./approval-rules.js";
import { simulationRefused, type PublishChain } from "./chain-port.js";
import type { FinalizeResult } from "./finalize.js";
import { reconcileAgent } from "./reconcile.js";

// Creator co-signature (PACKAGE_SPEC.md 15.2, plan §3.3): the server builds the call batch when the creator clicks, the
// creator's wallet signs ONE Tempo transaction and the platform relay pays the fee. Price, hash, version and royalty
// ALWAYS come from the approved record (`package_submissions.approved`) and the license cap from the validated manifest
// stored on the submission; never from the client. The publication is confirmed afterwards by tx hash.

type SubmissionRow = typeof schema.packageSubmissions.$inferSelect;

const sameWallet = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The submission must exist and belong to the authenticated wallet. */
export async function loadOwnedSubmission(submissionId: string, wallet: string): Promise<SubmissionRow> {
  const [sub] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, submissionId));
  if (!sub) throw notFound("Submission not found");
  if (!sameWallet(sub.creatorWallet, wallet)) throw forbidden("This submission belongs to another wallet");
  return sub;
}

/** New Solver = no version of this agent was ever published. */
export async function isNewAgent(sub: Pick<SubmissionRow, "id" | "agentId">): Promise<boolean> {
  const [prior] = await db
    .select({ id: schema.packageSubmissions.id })
    .from(schema.packageSubmissions)
    .where(and(eq(schema.packageSubmissions.agentId, sub.agentId), ne(schema.packageSubmissions.id, sub.id), inArray(schema.packageSubmissions.status, ["published", "superseded", "suspended", "withdrawn"])))
    .limit(1);
  return !prior;
}

const wrongState = (status: string) => new HttpError(409, "This version is not waiting for your signature right now.", "submission_state", { status });

/**
 * Builds the batch of the requested step. Checks, in this order: the wallet (owner of the submission), the state
 * (`awaiting_creator_signature`), the approved record and the step against the chain read now (the client does not
 * choose the step: asking for the wrong one is a 409 `wrong_step` with the expected one). The batch is simulated as the
 * creator before it is returned, so a refusal (low balance, paused registrations) shows up before the wallet opens.
 */
export async function buildPublicationTx(kind: CreatorSigningStep, wallet: string, submissionId: string, port: PublishChain): Promise<TxResponse> {
  const sub = await loadOwnedSubmission(submissionId, wallet);
  if (!SIGNABLE_STATUSES.includes(sub.status as SubmissionStatus)) throw wrongState(sub.status);
  const approved = parseApproved(sub.approved);
  if (!approved) throw new HttpError(409, "This version has not been approved by the review yet.", "not_approved");

  const state = await port.fetchAgentState(sub.agentId);
  const step = nextPublicationStep(approved, state, wallet);
  if (step === "blocked") {
    throw new HttpError(409, "This Solver is blocked on the network (suspended or owned by another wallet); contact the team.", "publication_blocked");
  }
  const expected = stepMismatch(kind, step);
  if (expected) throw new HttpError(409, "This is not the right step right now.", "wrong_step", { expected, requested: kind });

  let built: TxResponse;
  if (kind === "register-agent") {
    const config = await port.config();
    const royalty = royaltyProblem(approved.royaltyBps, config.platformRoyaltyBps);
    if (royalty) throw new HttpError(409, `The approved royalty cannot be registered: ${royalty}.`, "royalty_too_high");
    if (approvedPriceUnits(approved) < config.minPrice) {
      throw new HttpError(409, "The approved price is below the network minimum.", "price_too_low", { minPriceUnits: config.minPrice.toString() });
    }
    // The Registry pulls the creator's stake (minStake) at registration: warn before the wallet opens.
    if (config.minStake > 0n) {
      const balance = await port.tokenBalance(wallet);
      if (balance < config.minStake) {
        throw new HttpError(400, "Not enough balance for the Solver deposit", "insufficient_funds", {
          balanceUnits: balance.toString(),
          neededUnits: config.minStake.toString(),
          faucetEnabled: env.FAUCET_ENABLED,
        });
      }
    }
    built = await port.buildRegister(wallet, sub.agentId, approved, { maxSupply: maxSupplyOf(sub.manifest) });
  } else if (kind === "update-version") {
    built = await port.buildUpdateVersion(wallet, sub.agentId, approved, state);
  } else {
    built = await port.buildUpdatePricing(wallet, sub.agentId, approved, state);
  }
  const refused = await port.simulate(wallet, built.calls);
  if (refused) throw simulationRefused(refused);
  return built;
}

/** What is missing for the Solver to go live, read from the chain now (the creator's screen calls it before each step). */
export async function publicationPlan(submissionId: string, wallet: string, port: PublishChain): Promise<PublicationPlan> {
  const sub = await loadOwnedSubmission(submissionId, wallet);
  const approved = parseApproved(sub.approved);
  const status = sub.status as SubmissionStatus;
  const newAgent = await isNewAgent(sub);
  const base = { submissionId: sub.id, status, isNewAgent: newAgent, error: sub.error ?? null };
  if (!approved) {
    return { ...base, step: null, label: null, approved: null, chain: { registered: false, version: null, priceUnits: null, status: null }, register: null };
  }
  const state: ChainAgentState = await port.fetchAgentState(sub.agentId);
  const step: PublicationStep = nextPublicationStep(approved, state, wallet);
  let register: PublicationPlan["register"] = null;
  if (step === "register-agent" && SIGNABLE_STATUSES.includes(status)) {
    const [config, balance] = await Promise.all([port.config(), port.tokenBalance(wallet)]);
    register = { stakeUnits: config.minStake.toString(), balanceUnits: balance.toString(), faucetEnabled: env.FAUCET_ENABLED };
  }
  return {
    ...base,
    step,
    label: STEP_LABEL[step],
    approved: { name: approved.name, version: approved.version, priceUnits: approvedPriceUnits(approved).toString(), royaltyBps: approved.royaltyBps },
    chain: state.exists
      ? { registered: true, version: state.version, priceUnits: state.price.toString(), status: state.status }
      : { registered: false, version: null, priceUnits: null, status: null },
    register,
  };
}

/** Result summary (submission state AFTER the call) in the `PublicationResult` shape. */
export async function publicationResult(submissionId: string, result: FinalizeResult | null, port: PublishChain | null = null): Promise<PublicationResult> {
  const [sub] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, submissionId));
  if (!sub) throw notFound("Submission not found");
  let step: PublicationStep | null = result?.outcome === "not_ready" ? (result.step ?? null) : null;
  if (!step && port && result === null) {
    const approved = parseApproved(sub.approved);
    if (approved) step = nextPublicationStep(approved, await port.fetchAgentState(sub.agentId));
  }
  return {
    submissionId,
    status: sub.status as SubmissionStatus,
    outcome: result ? result.outcome : sub.status === "published" ? "already_published" : "not_ready",
    step,
    error: result?.outcome === "failed" ? result.error : (sub.error ?? null),
  };
}

/**
 * After the wallet sent the batch: checks the receipt by tx hash (sent by the creator, publication events of THIS agent
 * matching the approved record), hands it to the indexer, records `register_tx` and lets the flow advance (new Solver ->
 * `awaiting_onchain_approval`; complete update -> published right away). Idempotent.
 */
export async function confirmPublication(input: PublicationConfirmInput, wallet: string, port: PublishChain): Promise<PublicationResult> {
  const sub = await loadOwnedSubmission(input.submissionId, wallet);
  const approved = parseApproved(sub.approved);
  if (!approved) throw new HttpError(409, "This version has not been approved by the review yet.", "not_approved");
  const kind = input.kind ? STEP_TO_TOUCH[input.kind] : undefined;
  const verdict = await port.verifyCreatorTx(input.txHash, sub.agentId, { creatorWallet: sub.creatorWallet, approved, ...(kind ? { kind } : {}) });
  if (!verdict.ok) throw badRequest("This transaction does not belong to this Solver.", "tx_not_for_agent", { reason: verdict.reason });
  await port.indexTx(input.txHash).catch((e) => console.warn(`[publish] indexing ${input.txHash} failed: ${(e as Error).message}`));
  const touched = verdict.kinds.includes("registered") ? "registered" : verdict.kinds.includes("version") ? "version" : "pricing";
  // `verified`: checkCreatorTx already matched this transaction's events against the approved record.
  const { result } = await reconcileAgent(sub.agentId, { txHash: input.txHash, kind: touched, verified: true }, { port });
  return publicationResult(sub.id, result, port);
}
