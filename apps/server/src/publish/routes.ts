import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PublicationConfirmInput, PublicationTxInput, type TxResponse } from "@solvers/shared";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { h, notFound, parse } from "../lib/http.js";
import { requireAdminWallet } from "./admin.js";
import { publishChain } from "./chain-port.js";
import { finalizePublication } from "./finalize.js";
import { registerPublishListeners } from "./reconcile.js";
import { buildPublicationTx, confirmPublication, publicationPlan, publicationResult } from "./tx.js";

// Publication area: the creator's co-signed transaction and the admin's completion (PACKAGE_SPEC.md 14.4 and 15).
// Mounted under /api by modules.ts:
//   POST /tx/register-agent | /tx/update-version | /tx/update-pricing   { submissionId } -> TxResponse (the wallet sends the
//                                                                        calls as ONE sponsored batch, then confirms)
//   GET  /tx/publication/:submissionId                                   -> PublicationPlan (what is missing)
//   POST /tx/publication/confirm                                         { submissionId, txHash, kind? } -> PublicationResult
//   POST /admin/submissions/:id/finish                                   (site admin) -> PublicationResult
// Chain events reach the submission through the indexer listener (`registerPublishListeners`) and the
// `publish: reconcile` job (`publishJobs`).
export const publishRouter: Router = Router();

registerPublishListeners();

for (const kind of ["register-agent", "update-version", "update-pricing"] as const) {
  publishRouter.post(
    `/tx/${kind}`,
    requireAuth,
    h(async (req): Promise<TxResponse> => {
      const wallet = requireWallet(req);
      const { submissionId } = parse(PublicationTxInput, req.body);
      return buildPublicationTx(kind, wallet, submissionId, publishChain());
    }),
  );
}

publishRouter.get(
  "/tx/publication/:submissionId",
  requireAuth,
  h(async (req) => publicationPlan(String(req.params.submissionId), requireWallet(req), publishChain())),
);

publishRouter.post(
  "/tx/publication/confirm",
  requireAuth,
  h(async (req) => confirmPublication(parse(PublicationConfirmInput, req.body), requireWallet(req), publishChain())),
);

/** Finishes the publication when the on-chain approval did not arrive by itself (or after `publish_failed`). Idempotent. */
publishRouter.post(
  "/admin/submissions/:id/finish",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    requireAdminWallet(wallet);
    const id = String(parse(z.object({ id: z.string().min(1).max(64) }), req.params).id);
    const [sub] = await db.select({ id: schema.packageSubmissions.id }).from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id));
    if (!sub) throw notFound("Submission not found");
    const result = await finalizePublication(id, { actor: wallet.toLowerCase() });
    return publicationResult(id, result, publishChain());
  }),
);
