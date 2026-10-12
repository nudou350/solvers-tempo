import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { sendTelegram } from "../notify/telegram.js";

// Review notifications over Telegram (PACKAGE_SPEC.md 14.5): the admin is notified of new submissions and state changes;
// the creator, when they have Telegram linked, of decisions. Best effort: a failed notification never breaks the flow.

const short = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

export async function notifyAdmin(text: string): Promise<void> {
  try {
    await sendTelegram(env.TELEGRAM_ADMIN_CHAT_ID, text);
  } catch (e) {
    console.warn("[submissions] admin notification failed:", (e as Error).message);
  }
}

export async function notifyCreatorWallet(wallet: string, text: string): Promise<void> {
  try {
    const [c] = await db.select({ chat: schema.creators.telegramChatId }).from(schema.creators).where(eq(schema.creators.wallet, wallet));
    if (c?.chat) await sendTelegram(c.chat, text);
  } catch (e) {
    console.warn("[submissions] creator notification failed:", (e as Error).message);
  }
}

type Subject = { id: string; slug: string; version: string; creatorWallet: string; name?: string | null };

const label = (s: Subject) => `${s.name ?? (s.slug || "(unnamed)")} ${s.version ? `v${s.version}` : ""}`.trim();

/** Admin-facing text for each state change. */
export function adminMessage(event: "submitted" | "pending_review" | "rejected_validation" | "creator_signed" | "resubmitted", s: Subject, extra?: string): string {
  const head = `Solvers: submission ${label(s)} (${short(s.creatorWallet)}) `;
  switch (event) {
    case "submitted":
      return `${head}arrived and will be validated.`;
    case "resubmitted":
      return `${head}was resubmitted with changes.`;
    case "pending_review":
      return `${head}passed validation and awaits review. ${extra ?? ""}`.trim();
    case "rejected_validation":
      return `${head}was rejected by the validator. ${extra ?? ""}`.trim();
    case "creator_signed":
      return `${head}was signed by the creator. ${extra ?? ""}`.trim();
  }
}

export function creatorMessage(event: "pending_review" | "rejected_validation" | "changes_requested" | "rejected" | "approved", s: Subject, notes?: string): string {
  const what = label(s);
  switch (event) {
    case "pending_review":
      return `Solvers: your package ${what} passed validation and is now in the review queue (target: 5 business days).`;
    case "rejected_validation":
      return `Solvers: your package ${what} did not pass validation. Open the submission on the site to see the errors and fix them.`;
    case "changes_requested":
      return `Solvers: the reviewer requested changes to ${what}.${notes ? `\n\n${notes.slice(0, 600)}` : ""}`;
    case "rejected":
      return `Solvers: ${what} was not approved.${notes ? `\n\n${notes.slice(0, 600)}` : ""}`;
    case "approved":
      return `Solvers: ${what} was approved in review. You still need to sign the registration on the site to publish it.`;
  }
}
