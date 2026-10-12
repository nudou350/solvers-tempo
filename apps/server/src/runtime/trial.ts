import type { MyTrial, TrialInfo } from "@solvers/shared";
import type { Manifest } from "./manifest.js";
import type { SolverPackage } from "./packages.js";

// Per-specialist free trial (manifest.trial): limits and texts. Pure functions (no env/database),
// tested in test/trial.test.ts. The counters are enforced by runtime/access.ts.

/** Input cap of a tool during the trial: files and bytes per run. */
export type ToolCap = { maxFiles?: number; maxBytes?: number };

export type TrialLimits = {
  uses: number;
  steps: number;
  searches: number;
  /** Runs per tool in the whole trial (only unlocked tools, limit > 0). */
  tools: Record<string, number>;
  /** Input cap per run, only for unlocked tools. */
  toolCaps: Record<string, ToolCap>;
  /** Templates unlocked in the trial (names from `trial.templates`; none by default). */
  templates: string[];
  /** Agreed request size during the trial, passed on to the AI. */
  scope: string | null;
  summary: string;
  lockedSummary: string;
};

/** What the wallet has already spent of the trial (trials table). */
export type TrialUsage = { searchesUsed: number; toolRuns: Record<string, number> };

/** The specialist's trial limits, or null when it offers no free trial. */
export function trialLimits(m: Pick<Manifest, "trial"> & { trial?: { templates?: string[] } }): TrialLimits | null {
  const t = m.trial;
  if (!t || !t.available) return null;
  const tools = Object.fromEntries(Object.entries(t.tools).filter(([, n]) => n > 0));
  const toolCaps = Object.fromEntries(Object.entries(t.toolLimits).filter(([name, cap]) => name in tools && (cap.maxFiles || cap.maxBytes)));
  return { uses: t.uses, steps: t.steps, searches: t.searches, tools, toolCaps, templates: t.templates ?? [], scope: t.scope ?? null, summary: t.summary, lockedSummary: t.lockedSummary };
}

/** The specialist's trial for the storefront (AgentDetail.trial). */
export function trialInfo(pkg: Pick<SolverPackage, "manifest" | "steps">): TrialInfo | null {
  const t = trialLimits(pkg.manifest);
  if (!t) return null;
  return {
    uses: t.uses,
    steps: t.steps,
    totalSteps: pkg.steps.length,
    searches: t.searches,
    tools: Object.entries(t.tools).map(([name, limit]) => ({ name, limit })),
    scope: t.scope,
    summary: t.summary,
    lockedSummary: t.lockedSummary,
  };
}

/** Balance left for the whole trial (GET /api/me/access). */
export function trialLeft(t: TrialLimits, usage: TrialUsage | null) {
  return {
    searchesLeft: Math.max(0, t.searches - (usage?.searchesUsed ?? 0)),
    toolsLeft: Object.fromEntries(Object.entries(t.tools).map(([name, limit]) => [name, Math.max(0, limit - (usage?.toolRuns[name] ?? 0))])),
  };
}

/** The wallet's ongoing trial for the library (GET /me/trials). */
export function myTrial(agentId: string, t: TrialLimits, used: number, usage: TrialUsage, lastUsedAt: Date): MyTrial {
  const left = trialLeft(t, usage);
  return {
    agentId,
    uses: t.uses,
    usesLeft: Math.max(0, t.uses - used),
    searches: t.searches,
    searchesLeft: left.searchesLeft,
    tools: Object.entries(t.tools).map(([name, limit]) => ({ name, limit, left: left.toolsLeft[name] ?? 0 })),
    lastUsedAt: lastUsedAt.toISOString(),
  };
}

/** Is step `index` (0-based) outside the trial? The wrap-up (index >= total) is never locked. */
export function trialStepLocked(t: TrialLimits, index: number, totalSteps: number): boolean {
  return index < totalSteps && index >= t.steps;
}

/** Size of a tool's input: files (when it comes as { files }, an array or an object) and bytes. */
export function toolInputSize(input: unknown): { files: number | null; bytes: number } {
  const files = input && typeof input === "object" ? (input as { files?: unknown }).files : undefined;
  const entries: [string, string][] | null = Array.isArray(files)
    ? files.map((f) => [String(f?.path ?? ""), String(f?.content ?? "")])
    : files && typeof files === "object"
      ? Object.entries(files).map(([path, content]) => [path, String(content)])
      : null;
  if (!entries) return { files: null, bytes: Buffer.byteLength(JSON.stringify(input ?? null)) };
  return { files: entries.length, bytes: entries.reduce((a, [path, content]) => a + Buffer.byteLength(path) + Buffer.byteLength(content), 0) };
}

// The cap rounds down and the sent size rounds up: whoever exceeds the cap never reads "30 KB" against "30 KB".
const capKb = (bytes: number) => `${Math.floor(bytes / 1000)} KB`;
const sentKb = (bytes: number) => `${Math.ceil(bytes / 1000)} KB`;

function capText(cap: ToolCap): string {
  const parts = [cap.maxFiles ? `${cap.maxFiles} ${cap.maxFiles === 1 ? "file" : "files"}` : "", cap.maxBytes ? capKb(cap.maxBytes) : ""].filter(Boolean);
  return listEn(parts);
}

/**
 * Does the input exceed the tool's trial cap? Returns the text for the AI to relay (not an error and
 * spends no balance), or null when it fits. Callers only apply this in a trial session.
 */
export function trialToolCapError(tool: string, cap: ToolCap | undefined, input: unknown, purchaseLink: string): string | null {
  if (!cap) return null;
  const size = toolInputSize(input);
  const tooMany = cap.maxFiles != null && size.files != null && size.files > cap.maxFiles;
  const tooBig = cap.maxBytes != null && size.bytes > cap.maxBytes;
  if (!tooMany && !tooBig) return null;
  const sent = [size.files != null ? `${size.files} ${size.files === 1 ? "file" : "files"}` : "", sentKb(size.bytes)].filter(Boolean).join(", ");
  return `Nothing was run and no free-trial balance was spent. In the free trial, ${tool} accepts up to ${capText(cap)} per run (you sent ${sent}). Send only the main component and its test, then run it again. The lifetime license removes this limit. Buy: ${purchaseLink}`;
}

const clause = (s: string) => s.trim().replace(/[\s.;!]+$/, "");
export const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);

function listEn(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * End-of-trial text, for the AI to relay to the user (not an error). Used when the next step,
 * the knowledge base query or the requested tool are outside what the trial unlocks.
 */
export function trialEndText(name: string, t: Pick<TrialLimits, "summary" | "lockedSummary">, purchaseLink: string): string {
  return `The free trial of ${name} ends here: ${clause(t.summary)}. With the lifetime license you also get: ${clause(t.lockedSummary)}. Buy: ${purchaseLink}`;
}

/** How many free uses are left after this one; on the last one, warns that the trial ends here. */
function usesLeftText(left: number): string {
  if (left <= 0) return "This is the last free use.";
  return left === 1 ? "After this one, 1 free use is left." : `After this one, ${left} free uses are left.`;
}

function stepsText(steps: number, total: number): string {
  if (steps >= total) return total === 1 ? "unlocks the single step" : `unlocks all ${total} steps`;
  return steps === 1 ? `unlocks step 1 of ${total}` : `unlocks steps 1 to ${steps} of ${total}`;
}

/**
 * activate_solver access line in a trial session: the limits in English, so the AI can
 * tell the user before starting. `use` is the number of this use (1..uses).
 */
export function trialAccessLine(
  t: TrialLimits,
  ctx: { use: number; totalSteps: number; toolNames: string[]; usage?: TrialUsage | null },
): string {
  const left = trialLeft(t, ctx.usage ?? null);
  const rest = (limit: number, remaining: number) => (remaining < limit ? ` (${remaining} left)` : "");
  const parts = [stepsText(t.steps, ctx.totalSteps)];
  parts.push(t.searches > 0 ? `up to ${t.searches} knowledge base ${t.searches === 1 ? "search" : "searches"}${rest(t.searches, left.searchesLeft)}` : "no knowledge base searches");
  for (const [name, limit] of Object.entries(t.tools)) parts.push(`${name} ${times(limit)}${rest(limit, left.toolsLeft[name] ?? 0)}`);
  const blocked = ctx.toolNames.filter((n) => !(n in t.tools));
  const capped = Object.entries(t.toolCaps).map(([name, cap]) => `${name} accepts up to ${capText(cap)}`);
  const lines = [
    `Free trial (use ${ctx.use} of ${t.uses}): ${listEn(parts)} in total.`,
    usesLeftText(t.uses - ctx.use),
    blocked.length ? `License only: ${listEn(blocked)}.` : "",
    capped.length ? `Size limit per run in the trial: ${listEn(capped)}.` : "",
    t.templates.length ? `Templates available in the trial (get_template): ${listEn(t.templates)}.` : "",
    `${clause(t.summary)}.`,
    t.scope ? `Trial scope: ${clause(t.scope)}.` : "",
    "Tell the user about these limits before you start.",
  ];
  return lines.filter(Boolean).join(" ");
}
