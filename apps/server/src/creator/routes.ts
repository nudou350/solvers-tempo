import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { CreatorProfileInput, type CreatorMe, type SubmissionView, type TelegramLink } from "@solvers/shared";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { h, HttpError, notFound, parse } from "../lib/http.js";
import { manifestJsonSchema } from "../runtime/validate/json-schema.js";
import { adminRouter } from "../submissions/admin-routes.js";
import { isNewAgent, listColumns, newAgentSet } from "../submissions/lookup.js";
import { SUBMISSION_ID_RE } from "../submissions/paths.js";
import { creatorNotReady, isAdminWallet, normalizeInviteCode, toSubmissionView } from "../submissions/rules.js";
import { botUsername } from "../telegram/client.js";
import { deepLinkOf, LINK_MAX_PER_WINDOW } from "../telegram/link-rules.js";
import { issueLinkCode } from "../telegram/link-store.js";

// Creator and site-review routes (PACKAGE_SPEC.md 14.4), mounted under /api:
//   GET /creator/me, POST /creator/profile, POST /creator/telegram-link, GET /creator/submissions[/:id]
//   GET /admin/submissions[/:id[/file|/knowledge-search]], POST /admin/submissions/:id/(approve|request-changes|reject)  (admin-routes.ts)
//   GET /spec/manifest.schema.json
// The upload (POST /creator/submissions, raw streamed body) lives in submissions/upload.ts and is mounted in app.ts before express.json.
export const creatorRouter: Router = Router();

type CreatorRow = typeof schema.creators.$inferSelect;

function meOf(wallet: string, c: CreatorRow | undefined, bot: string | null): CreatorMe {
  return {
    wallet: wallet as CreatorMe["wallet"],
    hasProfile: !!c,
    invited: c?.invited ?? false,
    termsAccepted: c?.termsAcceptedAt != null,
    name: c?.name ?? null,
    bio: c?.bio ?? null,
    // Verified escalation contact = linked Telegram (through the bot, with the code of POST /creator/telegram-link;
    // the admin can also link it with cli:invite set-chat).
    contactVerified: c?.telegramChatId != null,
    canSubmit: creatorNotReady(c) === null,
    isAdmin: isAdminWallet(wallet, env.ADMIN_WALLETS),
    telegramBot: bot ? { username: bot } : null,
  };
}

/** The bot's @username (cached), or null: GET /creator/me never fails because of Telegram. */
const botOf = (): Promise<string | null> => botUsername().catch(() => null);

async function creatorOf(wallet: string): Promise<CreatorRow | undefined> {
  const [c] = await db.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
  return c;
}

creatorRouter.get(
  "/creator/me",
  requireAuth,
  h(async (req): Promise<CreatorMe> => {
    const wallet = requireWallet(req);
    return meOf(wallet, await creatorOf(wallet), await botOf());
  }),
);

/**
 * Code to link Telegram (PACKAGE_SPEC.md 14.1): `LINK-` + 8 characters, only the hash is stored, valid 15 min, single
 * use, up to 5 per hour per creator. The creator sends `/vincular CODE` to the bot (or opens the deepLink) and the worker
 * stores the chat. Only for creators with a profile. The bot is checked BEFORE a code of the limit is spent.
 */
creatorRouter.post(
  "/creator/telegram-link",
  requireAuth,
  h(async (req): Promise<TelegramLink> => {
    const wallet = requireWallet(req);
    const bot = await botUsername();
    if (!bot) throw new HttpError(503, "Telegram linking is unavailable right now. Try again in a few minutes or contact the team.", "telegram_unavailable");
    const r = await issueLinkCode(wallet);
    if (r.status === "no_profile") throw new HttpError(403, "Save your creator profile before linking Telegram.", "profile_required");
    if (r.status === "limited") {
      throw new HttpError(429, `You have already generated ${LINK_MAX_PER_WINDOW} codes in the last hour. Try again in ${Math.ceil(r.retryAfterSec / 60)} min.`, "too_many_codes", { retryAfterSec: r.retryAfterSec });
    }
    return { code: r.code, expiresAt: r.expiresAt.toISOString(), botUsername: bot, deepLink: deepLinkOf(bot, r.code) };
  }),
);

/**
 * Profile sign-up/update. The first sign-up needs a valid unused invite: the wallet becomes the invite's owner and
 * `creators.invited` becomes true, all in one transaction (two sign-ups with the same code cannot both pass).
 */
creatorRouter.post(
  "/creator/profile",
  requireAuth,
  h(async (req): Promise<CreatorMe> => {
    const wallet = requireWallet(req);
    const body = parse(CreatorProfileInput, req.body);
    await db.transaction(async (tx) => {
      // Lock per wallet: two submissions of the same form become a single sign-up.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`creator-profile:${wallet}`}, 0))`);
      const [existing] = await tx.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
      if (existing?.invited) {
        await tx
          .update(schema.creators)
          .set({ name: body.name, bio: body.bio, termsAcceptedAt: existing.termsAcceptedAt ?? new Date() })
          .where(eq(schema.creators.id, existing.id));
        return;
      }
      if (!body.inviteCode) throw new HttpError(400, "Enter your invite code to create your creator profile.", "invite_required");
      const code = normalizeInviteCode(body.inviteCode);
      const claimed = await tx
        .update(schema.creatorInvites)
        .set({ wallet, usedAt: new Date() })
        .where(sql`${schema.creatorInvites.code} = ${code} and ${schema.creatorInvites.usedAt} is null`)
        .returning({ code: schema.creatorInvites.code });
      if (claimed.length === 0) {
        const [known] = await tx.select({ code: schema.creatorInvites.code }).from(schema.creatorInvites).where(eq(schema.creatorInvites.code, code));
        if (known) throw new HttpError(409, "This invite has already been used.", "invite_used");
        throw new HttpError(400, "Invalid invite. Check the code you received.", "invite_invalid");
      }
      const now = new Date();
      if (existing) {
        await tx.update(schema.creators).set({ name: body.name, bio: body.bio, invited: true, termsAcceptedAt: now }).where(eq(schema.creators.id, existing.id));
      } else {
        await tx.insert(schema.creators).values({ id: `cr_${randomId(8)}`, wallet, name: body.name, bio: body.bio, invited: true, termsAcceptedAt: now });
      }
    });
    return meOf(wallet, await creatorOf(wallet), await botOf());
  }),
);

creatorRouter.get(
  "/creator/submissions",
  requireAuth,
  h(async (req): Promise<SubmissionView[]> => {
    const wallet = requireWallet(req);
    // Light columns: nothing of the whole manifest (only the name, truncated in the database), `scans` or `approved`.
    const rows = await db
      .select({ ...listColumns, validation: schema.packageSubmissions.validation })
      .from(schema.packageSubmissions)
      .where(eq(schema.packageSubmissions.creatorWallet, wallet))
      .orderBy(desc(schema.packageSubmissions.createdAt))
      .limit(100);
    const fresh = await newAgentSet([...new Set(rows.map((r) => r.agentId))]);
    return rows.map((r) => toSubmissionView({ ...r, manifest: r.name ? { name: r.name } : null }, fresh.has(r.agentId)));
  }),
);

creatorRouter.get(
  "/creator/submissions/:id",
  requireAuth,
  h(async (req): Promise<SubmissionView> => {
    const wallet = requireWallet(req);
    const id = String(req.params.id);
    if (!SUBMISSION_ID_RE.test(id)) throw notFound("Submission not found.");
    const [row] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id));
    // Another creator's submission answers 404, not 403: it does not confirm the id exists.
    if (!row || row.creatorWallet !== wallet) throw notFound("Submission not found.");
    return toSubmissionView(row, await isNewAgent(row.agentId));
  }),
);

/** Manifest v1 schema (the same as `cli:schema`): public, only for autocompletion; the validator decides. */
creatorRouter.get("/spec/manifest.schema.json", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(manifestJsonSchema());
});

creatorRouter.use(adminRouter);
