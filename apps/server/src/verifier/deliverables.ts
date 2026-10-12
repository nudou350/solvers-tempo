import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { markPassedCalls } from "@solvers/chain";
import { solversEscrowAbi } from "@solvers/contracts-client";
import type { Hex } from "viem";
import { chainContext } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { processTxHash } from "../indexer/index.js";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.js";
import { randomToken, sha256, sha256Hex } from "../lib/crypto.js";
import { notifyCreator } from "../notify/telegram.js";
import { a11yCheck } from "../runtime/tools.js";
import { installDeliverable, type Installed } from "./install.js";
import { withKeyLock } from "./lock.js";
import { planMarkPassed, type ChainMilestone } from "./report.js";
import { runTests, sanitizeAcceptance, sanitizeFiles, writeFiles, type Files, type TestReport } from "./sandbox.js";

// Guarantee flow: the AI delivers; the server runs the acceptance suite agreed when the guarantee was created (the
// delivery cannot replace it); if it passes, the step is marked on-chain (`markPassed`, signed by the VERIFIER key on its
// own nonce lane, fee sponsored by RELAY) and a static watermarked preview is produced. The code is only downloadable
// after the step is approved or released. Deliverables live in DELIVERABLES_DIR/<escrowId>/<index>/.

const root = () => resolve(env.DELIVERABLES_DIR);

/** Directory keys are the on-chain escrow id (decimal) or a temporary key before it is known (no path separators). */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,100}$/;

function safeKey(key: string): string {
  if (!SAFE_KEY.test(key)) throw new Error(`invalid deliverable directory key: ${JSON.stringify(key)}`);
  return key;
}

export const milestoneDir = (escrowId: string, idx: number) => join(root(), safeKey(escrowId), String(idx));

/** Deterministic hash of a set of files: sha256 of (name + sha256(content)) in order. */
export function filesHash(files: Files): Buffer {
  return sha256(
    Object.keys(files)
      .sort()
      .map((k) => `${k}\0${sha256Hex(files[k]!)}`)
      .join("\n"),
  );
}

/** Writes the acceptance suite of a step and returns its hash (it goes into the on-chain criteria hash). */
export function saveAcceptance(escrowId: string, idx: number, tests: Files): { path: string; hash: string } {
  const files = sanitizeAcceptance(tests);
  const dir = join(milestoneDir(escrowId, idx), "acceptance");
  rmSync(dir, { recursive: true, force: true });
  writeFiles(dir, files);
  return { path: dir, hash: filesHash(files).toString("hex") };
}

/** Removes what `saveAcceptance` wrote for an escrow that was never created (refused simulation). New escrows only: removes its whole folder. */
export function discardAcceptance(escrowId: string): void {
  rmSync(join(root(), safeKey(escrowId)), { recursive: true, force: true });
}

/**
 * The escrow id is only known once `createEscrow` is mined: acceptance suites saved under a temporary key (e.g. the
 * purchase id without `0x`) move to the escrow id's folder. Returns the new acceptance path of `idx` (callers update
 * `milestones.acceptance_path`). No-op when the source is missing; refuses to overwrite an existing escrow folder.
 */
export function adoptAcceptance(tempKey: string, escrowId: string): { dir: string } {
  const from = join(root(), safeKey(tempKey));
  const to = join(root(), safeKey(escrowId));
  if (from === to || !existsSync(from)) return { dir: to };
  if (existsSync(to)) throw new Error(`deliverables folder for escrow ${escrowId} already exists`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { dir: to };
}

export function criteriaHash(title: string, criteria: string, acceptanceHash?: string | null): Buffer {
  return sha256(`${title}\n${criteria}${acceptanceHash ? `\n${acceptanceHash}` : ""}`);
}

/** Reads a deliverable/suite folder written by the server. Regular files only (symlinks and the like are ignored). */
export function readDeliverable(dir: string): Files {
  const out: Files = {};
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

type FinalReport = TestReport & { a11y?: ReturnType<typeof a11yCheck>; selfWrittenTestsOnly?: boolean };

/**
 * Acceptance suite of the step. If one was agreed (hash in the database and on-chain), what is on disk must exist and
 * match the hash: otherwise the check STOPS (it never falls back to "the delivery's own tests", which would silently
 * weaken the guarantee).
 */
function loadAcceptance(m: typeof schema.milestones.$inferSelect): Files | null {
  if (!m.acceptanceHash) return m.acceptancePath && existsSync(m.acceptancePath) ? readDeliverable(m.acceptancePath) : null;
  const files = m.acceptancePath ? readDeliverable(m.acceptancePath) : {};
  if (Object.keys(files).length === 0 || filesHash(files).toString("hex") !== m.acceptanceHash) {
    console.error(`[verifier] acceptance suite missing or different from the agreed hash (${m.escrowId}/${m.idx})`);
    throw new HttpError(
      500,
      "The agreed acceptance test suite for this step is not available. The check was stopped; please contact support.",
      "acceptance_unavailable",
    );
  }
  return files;
}

/** Step with tests: runs the agreed acceptance suite (or the delivery's tests) and the a11y check, if agreed. */
async function verifyWithTests(files: Files, m: typeof schema.milestones.$inferSelect): Promise<{ report: FinalReport; previewHtml: string | null }> {
  const acceptance = loadAcceptance(m);
  const { report, previewHtml } = await runTests(files, { acceptance });

  // Agreed accessibility criterion: static check of the delivered code (Portuguese criteria texts still match).
  const wantsA11y = /accessibility|acessibilidade|a11y/i.test(m.criteria);
  const a11y = wantsA11y ? a11yCheck(Object.fromEntries(Object.entries(files).filter(([n]) => !/\.test\./.test(n)))) : null;
  const finalReport: FinalReport = {
    ...report,
    passed: report.passed && (a11y?.passed ?? true),
    ...(a11y ? { a11y } : {}),
    // Without an acceptance suite the tests came from the delivery itself: the report says so explicitly.
    selfWrittenTestsOnly: !acceptance,
  };
  if (a11y && !a11y.passed) {
    finalReport.failures = [...finalReport.failures, ...a11y.issues.map((i) => ({ test: `accessibility: ${i.rule}`, message: `${i.file}: ${i.message}` }))];
  }
  return { report: finalReport, previewHtml };
}

/**
 * Manual review step (e.g. a plan): there is no automatic test. The delivery is shown to the buyer in the preview; they
 * approve or dispute within the window, otherwise it is released automatically.
 */
function manualReview(files: Files): { report: FinalReport; previewHtml: string } {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const previewHtml = Object.entries(files)
    .map(([name, content]) => `<h4>${esc(name)}</h4><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace">${esc(content)}</pre>`)
    .join("");
  return {
    report: { passed: true, mode: "manual", numTests: 0, numPassed: 0, numFailed: 0, acceptance: null, failures: [], durationMs: 0 },
    previewHtml,
  };
}

/** On-chain state of the step through `escrowOf` (null when the escrow or the step could not be read). */
async function readChainMilestone(escrowId: string, idx: number): Promise<(NonNullable<ChainMilestone> & { passedAt: number }) | null> {
  try {
    const c = chainContext();
    const [, , , , , , , milestones] = await c.publicClient.readContract({
      address: c.deployment.escrow,
      abi: solversEscrowAbi,
      functionName: "escrowOf",
      args: [BigInt(escrowId)],
    });
    const cm = milestones[idx];
    return cm ? { status: Number(cm.status), deliverableHash: cm.deliverableHash.toLowerCase().replace(/^0x/, ""), passedAt: Number(cm.passedAt) } : null;
  } catch (e) {
    console.warn("[verifier] could not read the step on-chain:", (e as Error).message);
    return null;
  }
}

/** Hands the confirmed markPassed to the indexer right away. */
async function indexTx(hash: Hex): Promise<void> {
  try {
    await processTxHash(hash);
  } catch (e) {
    console.warn(`[verifier] indexing ${hash} failed (the indexer catches up from the chain): ${(e as Error).message}`);
  }
}

/**
 * Mirrors a confirmed `markPassed` right away (the indexer does the same from the event): the step becomes `passed` with
 * the on-chain time, and the escrow's auto-release instant comes from the contract view. Guarded: only a step still
 * `pending`/`submitted` changes.
 */
async function mirrorPassed(escrowId: string, idx: number): Promise<void> {
  const c = chainContext();
  const chainStep = await readChainMilestone(escrowId, idx);
  if (!chainStep || chainStep.status !== 1) return;
  await db
    .update(schema.milestones)
    .set({ status: "passed", passedAt: new Date(chainStep.passedAt * 1000) })
    .where(and(eq(schema.milestones.escrowId, escrowId), eq(schema.milestones.idx, idx), inArray(schema.milestones.status, ["pending", "submitted"])));
  const at = await c.publicClient
    .readContract({ address: c.deployment.escrow, abi: solversEscrowAbi, functionName: "autoReleaseAt", args: [BigInt(escrowId)] })
    .catch(() => 0n);
  if (at > 0n) await db.update(schema.escrows).set({ autoReleaseAt: new Date(Number(at) * 1000) }).where(eq(schema.escrows.id, escrowId));
}

type SubmitInput = { wallet: string; agentId: string; escrowId: string; index: number; files: Files };

/**
 * Submission of a delivery. Serialized per step (escrow:idx): two submissions of the same step never run together, so
 * one never removes or overwrites the other's result.
 */
export function submitDeliverable(input: SubmitInput) {
  const files = sanitizeFiles(input.files);
  return withKeyLock(`${input.escrowId}:${input.index}`, () => submitLocked(input, files));
}

async function submitLocked(input: SubmitInput, files: Files) {
  const [escrow] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, input.escrowId));
  if (!escrow) throw notFound("Guaranteed task not found");
  if (escrow.buyerWallet.toLowerCase() !== input.wallet.toLowerCase()) throw forbidden("This guarantee belongs to another wallet");
  if (escrow.agentId !== input.agentId) throw badRequest("This guarantee belongs to another specialist");
  const where = and(eq(schema.milestones.escrowId, escrow.id), eq(schema.milestones.idx, input.index));
  if (!(await db.select().from(schema.milestones).where(where))[0]) throw notFound("Step not found");
  // The agreed criteria (texts + acceptance suite) must be on the step before any check runs: without them a delivery
  // would pass on its own tests. Fills them from the purchase ledger or refuses (409). Imported lazily: escrow-upkeep
  // imports this module.
  const { assertMilestoneTexts } = await import("../store/escrow-upkeep.js");
  await assertMilestoneTexts(escrow.id, input.index);
  const [m] = await db.select().from(schema.milestones).where(where);
  if (!m) throw notFound("Step not found");

  const hash = filesHash(files);
  const hashHex = hash.toString("hex");
  // "passed" with the same hash: the step was already approved on-chain with this same delivery (resend after a client
  // timeout, or a crash in the middle of a previous submission).
  const sameDelivery = m.status === "passed" && m.deliverableHash === hashHex;
  if (sameDelivery && m.previewUrl) {
    return {
      passed: true as const,
      report: (m.verifierReport ?? {}) as unknown as FinalReport,
      previewUrl: m.previewUrl,
      autoReleaseAt: escrow.autoReleaseAt?.toISOString() ?? null,
    };
  }
  if (!["pending", "submitted"].includes(m.status) && !sameDelivery) throw badRequest(`This step is already ${m.status}`);

  // Only the off-chain state changes here; nothing on disk from the previous attempt is touched before it passes.
  const onlySubmitted = and(where, eq(schema.milestones.status, "submitted"));
  // Back to "pending" (only while still "submitted", i.e. this attempt's). Never masks the original error.
  const backToPending = async () => {
    try {
      await db.update(schema.milestones).set({ status: "pending" }).where(onlySubmitted);
    } catch (e) {
      console.error("[verifier] could not return the step to pending:", (e as Error).message);
    }
  };
  if (m.status === "pending") await db.update(schema.milestones).set({ status: "submitted" }).where(where);

  let verified: { report: FinalReport; previewHtml: string | null };
  try {
    verified = m.verify === "manual" ? manualReview(files) : await verifyWithTests(files, m);
  } catch (e) {
    await backToPending();
    throw e;
  }
  const { report: finalReport, previewHtml } = verified;

  if (!finalReport.passed) {
    // Failure: only records the report and returns the step to "pending" (if still "submitted"). There are no files of
    // this attempt on disk to remove, and a "passed" step is never changed.
    await db
      .update(schema.milestones)
      .set({ status: "pending", verifierReport: finalReport as unknown as Record<string, unknown> })
      .where(onlySubmitted);
    return { passed: false as const, report: finalReport, previewUrl: null, autoReleaseAt: null };
  }

  // Before anything irreversible: does the on-chain state allow this delivery?
  const plan = planMarkPassed(await readChainMilestone(escrow.id, input.index), hashHex);
  if (plan === "conflict") {
    await backToPending();
    throw badRequest("This step was already marked on-chain with a different delivery.", "milestone_conflict");
  }

  // Persist the delivery, preview and report BEFORE markPassed. The /preview route only serves "passed"/"approved"
  // steps, so the URL is not reachable before the on-chain confirmation.
  const previewUrl = `${env.PUBLIC_API_URL.replace(/\/$/, "")}/preview/${escrow.id}/${input.index}?t=${randomToken(18)}`;
  let installed: Installed | null = null;
  try {
    installed = installDeliverable(milestoneDir(escrow.id, input.index), files, previewHtml);
    await db
      .update(schema.milestones)
      .set({ deliverablePath: installed.dir, deliverableHash: hashHex, previewUrl, verifierReport: finalReport as unknown as Record<string, unknown> })
      .where(where);
  } catch (e) {
    // Nothing was sent to the chain: undo the installation and the step goes back to pending.
    try {
      installed?.undo();
    } catch (u) {
      console.error("[verifier] could not undo the installation:", (u as Error).message);
    }
    await backToPending();
    throw e;
  }

  let markTx: Hex | null = null;
  if (plan === "send") {
    try {
      const c = chainContext();
      const r = await sendServerCalls({
        signer: "verifier",
        lane: "verifier",
        calls: markPassedCalls(c.deployment, { escrowId: BigInt(escrow.id), index: input.index, deliverableHash: `0x${hashHex}` }),
        kind: "mark-passed",
        ref: `${escrow.id}:${input.index}`,
      });
      markTx = r.hash;
    } catch (e) {
      // The transaction may have landed despite the error (e.g. a receipt timeout): check before failing.
      const outcome = planMarkPassed(await readChainMilestone(escrow.id, input.index), hashHex);
      if (outcome !== "already") {
        if (outcome === "conflict") {
          // Another delivery (a previous attempt in flight) was approved on-chain: disk and database go back to the
          // delivery the chain has; the indexer mirrors the status from its event.
          try {
            installed.undo();
            await db
              .update(schema.milestones)
              .set({ deliverablePath: m.deliverablePath, deliverableHash: m.deliverableHash, previewUrl: m.previewUrl, verifierReport: m.verifierReport })
              .where(where);
          } catch (u) {
            console.error("[verifier] could not restore the previous delivery:", (u as Error).message);
          }
          await backToPending();
          throw badRequest("This step was already marked on-chain with a different delivery.", "milestone_conflict");
        }
        // Uncertain outcome (the transaction may still land): keep this delivery saved, consistent with what would be
        // approved; the mirror keeps "passed" if it lands.
        installed.commit();
        await backToPending();
        throw e;
      }
    }
  }
  installed.commit();
  if (markTx) await indexTx(markTx);
  try {
    await mirrorPassed(escrow.id, input.index);
  } catch (e) {
    // Already approved on-chain and saved; the indexer syncs the database.
    console.warn("[verifier] mirroring the step after markPassed failed:", (e as Error).message);
  }

  const [after] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, escrow.id));
  void notifyCreator(escrow.agentId, `Solvers: step ${input.index + 1} of guarantee ${escrow.id} passed verification.`);
  return { passed: true as const, report: finalReport, previewUrl, autoReleaseAt: after?.autoReleaseAt?.toISOString() ?? null };
}
