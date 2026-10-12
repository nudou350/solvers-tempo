import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, type Dir } from "node:fs";
import { join } from "node:path";

// Reading files that COME FROM THE CONTAINER (the report folder, writable by the delivery's code).
// Untrusted code may leave a symlink to a host file there (e.g. the verifier key), a FIFO
// (readFileSync would hang the whole server) or a huge file. So nothing here uses readFileSync/existsSync
// directly: regular files only, never following symlinks, with a byte cap.

export type SafeRead =
  | { ok: true; data: Buffer }
  | { ok: false; reason: "missing" | "not_regular" | "too_large" | "error"; detail?: string };

export type ReadFailure = Extract<SafeRead, { ok: false }>["reason"];
export type SafeJson = { ok: true; value: unknown } | { ok: false; reason: ReadFailure | "invalid_json"; detail?: string };

const { O_RDONLY } = constants;
// Undefined on Windows (dev): there the lstat below already blocks symlinks.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/**
 * Reads a regular file of up to `maxBytes`. Never throws: symlink, FIFO, device, directory and
 * oversized file come back as `ok: false`. `missing` only when the path does not exist.
 */
export function readRegularFile(path: string, maxBytes: number): SafeRead {
  let fd: number | null = null;
  try {
    // lstat does not open the file (doesn't block on a FIFO) and doesn't follow symlinks.
    const pre = lstatSync(path);
    if (!pre.isFile()) return { ok: false, reason: "not_regular", detail: pre.isSymbolicLink() ? "symlink" : "special file" };
    // O_NOFOLLOW closes the window between lstat and open (the container's code may swap the file).
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_regular", detail: "special file" };
    if (st.size > maxBytes) return { ok: false, reason: "too_large", detail: `${st.size} bytes` };
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return { ok: true, data: buf.subarray(0, off) };
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    // ELOOP/EMLINK: O_NOFOLLOW refused a symlink.
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, reason: "not_regular", detail: "symlink" };
    return { ok: false, reason: "error", detail: code ?? String(e) };
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Reads JSON from the container with the same limits. Invalid JSON becomes `ok: false`, never an exception. */
export function readRegularJson(path: string, maxBytes: number): SafeJson {
  const r = readRegularFile(path, maxBytes);
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.data.toString("utf8")) as unknown };
  } catch (e) {
    return { ok: false, reason: "invalid_json", detail: (e as Error).message.slice(0, 200) };
  }
}

/** Readable reason for a refused read (goes into the failure report). */
export function describeReadFailure(what: string, r: { reason: string; detail?: string }): string {
  const why: Record<string, string> = {
    missing: "was not generated",
    not_regular: `is not a regular file (${r.detail ?? "invalid"})`,
    too_large: `exceeded the size limit (${r.detail ?? ""})`,
    invalid_json: `is not valid JSON (${r.detail ?? ""})`,
    error: `could not be read (${r.detail ?? ""})`,
  };
  return `${what} ${why[r.reason] ?? r.reason}`;
}

/**
 * Disk usage of a folder without following symlinks (report watchdog during the run). Reads the
 * entries one by one (Dir.readSync) and stops once past `maxEntries`: a folder with millions of
 * files is never loaded whole into the server's memory.
 */
export function dirUsage(dir: string, maxEntries = 1000): { bytes: number; entries: number; truncated: boolean } {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let handle: Dir;
    try {
      handle = opendirSync(d);
    } catch {
      continue; // folder without read permission: nothing to add
    }
    try {
      for (;;) {
        const ent = handle.readSync();
        if (!ent) break;
        if (++entries > maxEntries) return { bytes, entries, truncated: true };
        const full = join(d, ent.name);
        try {
          const st = lstatSync(full);
          if (st.isDirectory()) stack.push(full);
          else bytes += Math.max(st.size, (st.blocks ?? 0) * 512);
        } catch {
          /* vanished midway: ignore */
        }
      }
    } catch {
      /* read error midway through the folder: keep what was already added */
    } finally {
      try {
        handle.closeSync();
      } catch {
        /* already closed */
      }
    }
  }
  return { bytes, entries, truncated: false };
}
