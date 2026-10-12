import { join, resolve } from "node:path";
import { env } from "../env.js";

// Where each submission's original ZIP and extracted folder live (PACKAGE_SPEC.md 15.1):
//   SUBMISSIONS_DIR/<id>/package.zip   and   SUBMISSIONS_DIR/<id>/extracted/
// The id comes from the server (24 hex) and is checked before becoming a path; nothing the client writes ends up in a disk path.

export const SUBMISSION_ID_RE = /^[0-9a-f]{24}$/;

export const submissionsRoot = (): string => resolve(process.cwd(), env.SUBMISSIONS_DIR);

export function submissionDir(id: string): string {
  if (!SUBMISSION_ID_RE.test(id)) throw new Error("invalid submission id");
  return join(submissionsRoot(), id);
}

/** ZIP path relative to SUBMISSIONS_DIR (this is what goes in `zip_path`: it survives moving the folder). */
export const zipRelPath = (id: string): string => `${id}/package.zip`;
export const zipPathOf = (id: string): string => join(submissionDir(id), "package.zip");
export const extractedDirOf = (id: string): string => join(submissionDir(id), "extracted");

/** Knowledge version for the review's test ingestion (PACKAGE_SPEC.md 6.4); on approval it becomes the real version. */
export const stagingVersion = (submissionId: string): string => `staging:${submissionId}`;
