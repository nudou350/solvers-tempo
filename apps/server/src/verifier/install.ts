import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomId } from "../lib/crypto.js";

// Atomic installation (with undo) of the approved delivery. No env/DB: testable on its own.

function writeTree(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export type Installed = {
  dir: string;
  /** Restores exactly the delivery and preview that were there before (nothing from this attempt remains). */
  undo: () => void;
  /** Discards the backups: the new delivery is final. */
  commit: () => void;
};

/**
 * Puts the approved delivery in place: builds everything in a temporary folder owned by this attempt and
 * only then swaps it in with a rename. The previous delivery and preview are kept as backups until
 * `commit()`, and `undo()` restores them (used when the chain ended up with a different delivery).
 */
export function installDeliverable(mdir: string, files: Record<string, string>, previewHtml: string | null): Installed {
  const id = randomId(6);
  const stage = join(mdir, `.stage-${id}`);
  const oldFiles = join(mdir, `.old-${id}`);
  const oldPreview = join(mdir, `.old-${id}.html`);
  const dir = join(mdir, "files");
  const previewFile = join(mdir, "preview.html");
  let hadFiles = false;
  let hadPreview = false;
  const restore = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(previewFile, { force: true });
    if (hadFiles) renameSync(oldFiles, dir);
    if (hadPreview) renameSync(oldPreview, previewFile);
  };
  try {
    writeTree(join(stage, "files"), files);
    if (previewHtml) writeFileSync(join(stage, "preview.html"), previewHtml);
    hadFiles = existsSync(dir);
    hadPreview = existsSync(previewFile);
    if (hadFiles) renameSync(dir, oldFiles);
    if (hadPreview) renameSync(previewFile, oldPreview);
    try {
      renameSync(join(stage, "files"), dir);
      if (previewHtml) renameSync(join(stage, "preview.html"), previewFile);
    } catch (e) {
      restore();
      throw e;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return {
    dir,
    undo: restore,
    commit: () => {
      rmSync(oldFiles, { recursive: true, force: true });
      rmSync(oldPreview, { force: true });
    },
  };
}

