import { memoryStartInstruction } from "../memory/rules.js";
import { installGuide, keyAliases, normalizeKey } from "./guides.js";

// preflight_check evaluation (pure, no session or database): what is OK, what is missing
// (blocks) and what is optional and absent (only warns).

export type PreflightRequirement = {
  type: "client" | "connector" | "plan";
  label: string;
  key?: string;
  optional?: boolean;
  howTo?: string;
  helpUrl?: string;
};

/** Figma connector tools that may appear without "figma" in the name (with or without a prefix). */
const FIGMA_TOOL = /(^|_)get_(design_context|variable_defs|metadata|screenshot)$/;

/** Key and tool names are compared normalized: "Google Drive" matches "mcp__claude_ai_Google_Drive__search". */
export function connectorAvailable(key: string, tools: string[]): boolean {
  const k = normalizeKey(key);
  if (!k) return false;
  const names = tools.map(normalizeKey);
  const wanted = [k, ...keyAliases(k)];
  return names.some((t) => wanted.some((w) => t.includes(w))) || (k === "figma" && names.some((t) => FIGMA_TOOL.test(t)));
}

export function evaluatePreflight(requirements: PreflightRequirement[], availableTools: string[]) {
  const missing: string[] = [];
  const warnings: string[] = [];
  const ok: string[] = [];
  for (const r of requirements) {
    if (r.type === "connector") {
      const guide = installGuide(r);
      if (connectorAvailable(r.key ?? r.label, availableTools)) ok.push(`${r.label}: connected`);
      else if (r.optional) warnings.push(`${r.label} not connected: follow the no-connector path in step 1. If the user prefers to connect it:\n${guide}`);
      else missing.push(`${r.label}: NOT found.\n${guide}`);
    } else if (r.type === "plan") {
      ok.push(`${r.label}: recommended (does not block)`);
    } else {
      ok.push(`${r.label}: OK`);
    }
  }
  return { ok, missing, warnings, blocked: missing.length > 0 };
}

/** `memory`: the package uses memory (or has a calibration): the text says to call get_memory before step 1 (PACKAGE_SPEC.md 10.2). */
export function preflightText(
  requirements: PreflightRequirement[],
  availableTools: string[],
  sessionId: string,
  memory?: { agentId: string; onboarding: boolean },
): string {
  const { ok, missing, warnings } = evaluatePreflight(requirements, availableTools);
  const list = (items: string[]) => items.map((m) => `- ${m}`).join("\n");
  const warnText = warnings.length ? `\n\nWarnings (do not block):\n${list(warnings)}` : "";
  if (missing.length) {
    return `Missing requirements:\n${list(missing)}\n\nGuide the user through installing them and, once they confirm, run preflight_check again. Do not move on to next_step before that.${warnText}${ok.length ? `\n\nAlready OK:\n${list(ok)}` : ""}`;
  }
  const memoryText = memory ? `\n\n${memoryStartInstruction(memory.agentId, memory.onboarding)}` : "";
  return `All set:\n${list(ok) || "- no requirements"}${warnText}${memoryText}\n\nNow call next_step with session_id="${sessionId}" to get step 1.`;
}
