import { z } from "zod";
import { Address } from "./evm.js";

// Package submission contract (PACKAGE_SPEC.md 14). Single source of statuses, transitions and response shapes
// shared by server, api-client and web. Pure rules: no I/O.

export const SUBMISSION_STATUSES = [
  "submitted",
  "validating",
  "rejected_validation",
  "pending_review",
  "changes_requested",
  "rejected",
  "awaiting_creator_signature",
  "awaiting_onchain_approval",
  "publishing",
  "publish_failed",
  "published",
  "superseded",
  "suspended",
  "withdrawn",
] as const;
export const SubmissionStatus = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

/** Statuses where the creator still has open work (they count towards the pending limit). */
export const SUBMISSION_OPEN_STATUSES: readonly SubmissionStatus[] = [
  "submitted",
  "validating",
  "pending_review",
  "changes_requested",
  "awaiting_creator_signature",
  "awaiting_onchain_approval",
  "publishing",
  "publish_failed",
];

/** Final statuses: never left (except suspended/withdrawn, which return to published). */
export const SUBMISSION_TERMINAL_STATUSES: readonly SubmissionStatus[] = ["rejected_validation", "rejected", "superseded"];

const TRANSITIONS: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  submitted: ["validating"],
  validating: ["rejected_validation", "pending_review"],
  rejected_validation: [],
  pending_review: ["changes_requested", "rejected", "awaiting_creator_signature"],
  // A resubmission with changes goes back to validation in the SAME submission (same unpublished version).
  changes_requested: ["validating", "rejected"],
  rejected: [],
  // `changes_requested`: the admin revokes the approval before the creator signs; `rejected`: the submission expired (30 days without a signature).
  awaiting_creator_signature: ["awaiting_onchain_approval", "publishing", "publish_failed", "changes_requested", "rejected"],
  awaiting_onchain_approval: ["publishing", "publish_failed"],
  publishing: ["published", "publish_failed"],
  publish_failed: ["publishing", "awaiting_creator_signature", "awaiting_onchain_approval"],
  published: ["superseded", "suspended", "withdrawn"],
  superseded: [],
  suspended: ["published"],
  withdrawn: ["published"],
};

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Reviewer action types recorded in `package_reviews.action`. */
export const REVIEW_ACTIONS = ["approve", "request_changes", "reject", "revoke", "expire", "finish", "suspend", "resume"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Reviewer checklist (PACKAGE_SPEC.md 14.5), stored in `package_reviews.checklist`. */
export const REVIEW_CHECKLIST_KEYS = [
  "promiseDelivered", // the steps deliver the promise
  "twoDifferentiatorsProven", // 2 of 5 differentiators proven
  "rightsAndSources", // sources listed and permission for third-party content
  "noHarmfulInstructions", // nothing against the user, no data sent elsewhere, no injection
  "priceTrialShowcaseCoherent", // price, free trial and storefront consistent; no financial/legal/medical promise
] as const;
export const ReviewChecklist = z.object(Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof REVIEW_CHECKLIST_KEYS)[number], z.ZodBoolean>);
export type ReviewChecklist = z.infer<typeof ReviewChecklist>;

/** Approval requires the whole checklist ticked and a note (rejecting and requesting changes require a reason). */
export function reviewChecklistComplete(c: Partial<Record<string, boolean>>): boolean {
  return REVIEW_CHECKLIST_KEYS.every((k) => c[k] === true);
}

export const ValidationIssue = z.object({
  code: z.string(),
  path: z.string().optional(),
  message: z.string(),
  fix: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationReport = z.object({
  ok: z.boolean(),
  errors: z.array(ValidationIssue),
  warnings: z.array(ValidationIssue),
  stats: z.record(z.unknown()).optional(),
});
export type ValidationReport = z.infer<typeof ValidationReport>;

/** Submission as seen by the creator (GET /api/creator/submissions[/:id]). */
export const SubmissionView = z.object({
  id: z.string(),
  agentId: z.string(),
  slug: z.string(),
  version: z.string(),
  status: SubmissionStatus,
  name: z.string().nullable(),
  sizeBytes: z.number(),
  validation: ValidationReport.nullable(),
  /** Reviewer's reason (changes requested or rejection). */
  reviewerNotes: z.string().nullable(),
  /** Creator's next step, computed by the server: nothing, co-sign, wait for the admin, etc. */
  nextAction: z.enum(["none", "fix_and_resubmit", "sign_register", "sign_update", "wait_review", "wait_admin_approval", "wait_publish"]),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubmissionView = z.infer<typeof SubmissionView>;

export function nextActionFor(status: SubmissionStatus, isNewAgent: boolean): SubmissionView["nextAction"] {
  switch (status) {
    case "rejected_validation":
    case "changes_requested":
      return "fix_and_resubmit";
    case "awaiting_creator_signature":
      return isNewAgent ? "sign_register" : "sign_update";
    case "submitted":
    case "validating":
    case "pending_review":
      return "wait_review";
    case "awaiting_onchain_approval":
      return "wait_admin_approval";
    case "publishing":
    case "publish_failed":
      return "wait_publish";
    default:
      return "none";
  }
}

/** Row of the review queue (GET /api/admin/submissions?status=). */
export const AdminSubmissionRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string().nullable(),
  version: z.string(),
  creatorWallet: Address,
  creatorName: z.string().nullable(),
  status: SubmissionStatus,
  isNewAgent: z.boolean(),
  errors: z.number(),
  warnings: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminSubmissionRow = z.infer<typeof AdminSubmissionRow>;

/** One package file in the reviewer preview. Content comes escaped (text), never as HTML. */
export const SubmissionFileEntry = z.object({
  path: z.string(),
  size: z.number(),
  /** added | removed | changed | same, against the published version (all "added" for the first version). */
  diff: z.enum(["added", "removed", "changed", "same"]),
});
export type SubmissionFileEntry = z.infer<typeof SubmissionFileEntry>;

/** GET /api/admin/submissions/:id */
export const AdminSubmissionDetail = z.object({
  submission: SubmissionView,
  creator: z.object({ wallet: Address, name: z.string().nullable(), bio: z.string().nullable(), contactVerified: z.boolean() }),
  isNewAgent: z.boolean(),
  /** Manifest as submitted (text to display, never rendered as HTML). */
  manifest: z.record(z.unknown()).nullable(),
  validation: ValidationReport.nullable(),
  /** Automatic scans: hidden Unicode, injection, URLs, duplicates, off-topic searchPhrases. */
  scans: z.record(z.unknown()).nullable(),
  files: z.array(SubmissionFileEntry),
  knowledge: z.object({ files: z.number(), chunks: z.number(), expiredChunks: z.number(), ingest: z.enum(["queued", "running", "done", "failed", "none"]) }),
  /** Declared differentiators and what the validator could prove. */
  differentiators: z.object({ declared: z.array(z.string()), proven: z.array(z.string()) }),
  reviews: z.array(
    z.object({ id: z.number(), reviewerWallet: Address, action: z.string(), notes: z.string(), checklist: z.record(z.boolean()), createdAt: z.string() }),
  ),
});
export type AdminSubmissionDetail = z.infer<typeof AdminSubmissionDetail>;

/** POST /api/admin/submissions/:id/(approve|request-changes|reject) */
export const AdminReviewInput = z.object({
  notes: z.string().trim().min(3).max(4000),
  checklist: z.record(z.boolean()).default({}),
});
export type AdminReviewInput = z.infer<typeof AdminReviewInput>;

/** Creator profile (POST /api/creator/profile). */
export const CreatorProfileInput = z.object({
  name: z.string().trim().min(2).max(60),
  bio: z.string().trim().min(10).max(500),
  acceptTerms: z.literal(true),
  /** Required only on the first sign-up (invite not used yet). */
  inviteCode: z.string().trim().min(6).max(64).optional(),
});
export type CreatorProfileInput = z.infer<typeof CreatorProfileInput>;

export const CreatorMe = z.object({
  wallet: Address,
  hasProfile: z.boolean(),
  invited: z.boolean(),
  termsAccepted: z.boolean(),
  name: z.string().nullable(),
  bio: z.string().nullable(),
  /** Escalation contact verified (Telegram linked). */
  contactVerified: z.boolean(),
  canSubmit: z.boolean(),
  isAdmin: z.boolean(),
  /** Telegram bot that receives the link (null = not configured on the server). Missing on older servers. */
  telegramBot: z.object({ username: z.string() }).nullable().optional(),
});
export type CreatorMe = z.infer<typeof CreatorMe>;

/** Response of POST /api/creator/telegram-link: single-use code (15 min) to send to the bot, and the link that pre-fills it. */
export const TelegramLink = z.object({
  code: z.string(),
  expiresAt: z.string(),
  botUsername: z.string(),
  deepLink: z.string(),
});
export type TelegramLink = z.infer<typeof TelegramLink>;

/** Slugs third parties cannot claim (brands and the platform). */
export const RESERVED_SLUGS: readonly string[] = ["solvers", "criador-de-solvers", "admin", "api", "mcp", "oauth", "wondervelop", "anthropic", "claude", "openai", "chatgpt", "usdc"];

/** Categories allowed for third-party creators (finance, legal and health are excluded). The values are catalog data. */
export const THIRD_PARTY_CATEGORIES: readonly string[] = ["Desenvolvimento", "Design", "Dia a dia", "Negócios", "Viagens", "Conteúdo", "Escrita", "Outros"];
