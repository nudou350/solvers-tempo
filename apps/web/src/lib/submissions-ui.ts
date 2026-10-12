// Screen texts and rules of the package submission flow (PACKAGE_SPEC.md 14.2), in plain language.
// Pure functions: no React and no I/O. States and transitions come from @solvers/shared.
import type { SubmissionStatus, SubmissionView } from "@solvers/api-client";
import { ApiError } from "@solvers/api-client";

/** ZIP size limit checked in the browser (the server checks again). */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** Platform Solver that helps build the package. */
export const CREATOR_SOLVER_SLUG = "criador-de-solvers";

/** Translator of the "submissions" namespace (useTranslations / getTranslations). */
export type Tr = (key: string, values?: Record<string, string | number>) => string;

/** Review target the creator sees in the queue (PACKAGE_SPEC.md 14.5). */
export const reviewSlaText = (t: Tr): string => t("sla");

export type Tone = "ok" | "warn" | "bad" | "brand" | "plain";

export type StatusInfo = { label: string; text: string; tone: Tone };

const STATUS_TONE: Record<SubmissionStatus, Tone> = {
  submitted: "brand",
  validating: "brand",
  rejected_validation: "bad",
  pending_review: "brand",
  changes_requested: "warn",
  rejected: "bad",
  awaiting_creator_signature: "warn",
  awaiting_onchain_approval: "brand",
  publishing: "brand",
  publish_failed: "warn",
  published: "ok",
  superseded: "plain",
  suspended: "bad",
  withdrawn: "plain",
};

/** Short label (chip) and explanation of each state. `nextAction` only changes the signature text. */
export function statusInfo(t: Tr, status: SubmissionStatus, nextAction?: SubmissionView["nextAction"]): StatusInfo {
  const tone = STATUS_TONE[status];
  if (status === "awaiting_creator_signature") {
    return { label: t(`status.${status}.label`), text: t(nextAction === "sign_update" ? `status.${status}.textUpdate` : `status.${status}.textRegister`), tone };
  }
  if (status === "pending_review") return { label: t(`status.${status}.label`), text: t(`status.${status}.text`, { sla: reviewSlaText(t) }), tone };
  return { label: t(`status.${status}.label`), text: t(`status.${status}.text`), tone };
}

export const CHIP_TONE: Record<Tone, "ok" | "warn" | "red" | "brand" | "default"> = { ok: "ok", warn: "warn", bad: "red", brand: "brand", plain: "default" };

/** Timeline stages in the order they happen (texts under stages.<key>.title/text). */
export const STAGES = [{ key: "sent" }, { key: "check" }, { key: "review" }, { key: "sign" }, { key: "final" }, { key: "publish" }] as const;

/** Title and text of a timeline stage. */
export function stageInfo(t: Tr, key: (typeof STAGES)[number]["key"]): { title: string; text: string } {
  return { title: t(`stages.${key}.title`), text: key === "review" ? t("stages.review.text", { sla: reviewSlaText(t) }) : t(`stages.${key}.text`) };
}

export type StageState = "done" | "current" | "attention" | "failed" | "todo" | "skipped";

/** State of each timeline stage for a submission. */
export function stageStates(status: SubmissionStatus, nextAction?: SubmissionView["nextAction"]): StageState[] {
  // Position of the current stage and how it stands.
  let at = 0;
  let mode: "current" | "attention" | "failed" = "current";
  switch (status) {
    case "submitted":
      at = 0;
      break;
    case "validating":
      at = 1;
      break;
    case "rejected_validation":
      at = 1;
      mode = "failed";
      break;
    case "pending_review":
      at = 2;
      break;
    case "changes_requested":
      at = 2;
      mode = "attention";
      break;
    case "rejected":
      at = 2;
      mode = "failed";
      break;
    case "awaiting_creator_signature":
      at = 3;
      mode = "attention";
      break;
    case "awaiting_onchain_approval":
      at = 4;
      break;
    case "publishing":
      at = 5;
      break;
    case "publish_failed":
      at = 5;
      mode = "attention";
      break;
    case "published":
    case "superseded":
    case "suspended":
    case "withdrawn":
      at = STAGES.length;
      break;
  }
  // An update of an already approved Solver skips the platform's final approval (PACKAGE_SPEC.md 14.2).
  const skipFinal = nextAction === "sign_update";
  return STAGES.map((_, i) => {
    if (i === 4 && skipFinal) return "skipped";
    if (i < at) return "done";
    if (i === at) return mode;
    return "todo";
  });
}

/** Does the submission still accept a fixed resubmission from the creator? */
export const canResubmit = (s: SubmissionView): boolean => s.nextAction === "fix_and_resubmit";

/** Message for a ZIP upload (XHR) or any call error, without jargon (texts under uploadError.*). */
export function uploadErrorInfo(t: Tr, err: unknown): { title: string; text: string } {
  const pick = (k: string, server?: string) => ({ title: t(`uploadError.${k}.title`), text: server || t(`uploadError.${k}.text`) });
  if (err instanceof ApiError) {
    const server = err.message && err.message !== "Bad Request" && err.message !== "error" ? err.message : "";
    switch (true) {
      case err.status === 0 && err.code === "aborted":
        return pick("aborted");
      case err.status === 0:
        return pick("network");
      case err.status === 401:
        return pick("unauthorized");
      case err.status === 403:
        return pick("forbidden", server);
      case err.status === 409:
        return pick("conflict", server);
      case err.status === 413:
        return pick("tooLarge");
      case err.status === 429:
        return pick("rateLimited", server);
      case err.status === 400 || err.status === 415 || err.status === 422:
        return pick("rejected", server);
      case err.status >= 500:
        return pick("serverError");
      default:
        return pick("generic", server);
    }
  }
  return { title: t("uploadError.generic.title"), text: err instanceof Error && err.message ? err.message : t("uploadError.generic.text") };
}

/**
 * Short message for read failures (lists and details). `fallback` translates the rest by the API code; without it, the
 * message that came back is used.
 */
export function loadErrorText(t: Tr, err: unknown, fallback?: (e: unknown) => string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return t("loadError.unauthorized");
    if (err.status === 403) return t("loadError.forbidden");
    if (err.status >= 500) return t("loadError.serverError");
    return fallback ? fallback(err) : err.message;
  }
  return err instanceof Error ? (fallback ? fallback(err) : err.message) : t("loadError.generic");
}

// ----- Safety of the creator's content (review) -----

/**
 * Characters that do not show on screen but change what the reviewer reads: zero width, direction controls (bidi),
 * formatting marks, line separators, variation selectors, "tags" and control characters (except tab and line breaks).
 * Kept as code points (not a regex with escapes) so the file does not depend on how an editor handles them.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
];

const isHidden = (cp: number): boolean => HIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Replaces each invisible character with a visible mark (e.g. `[U+200B]`) so the reviewer sees what a preview would hide. */
export function revealHidden(text: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isHidden(cp)) {
      count++;
      out += `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
    } else out += ch;
  }
  return { text: out, count };
}

/** JSON to display as text (never as HTML). Values that do not fit in JSON become plain text. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
