import { z } from "zod";
import { AGENT_ID_RE } from "../agent-ids.js";
import { ManifestBase } from "../manifest.js";

// Schema of the `specVersion: 1` manifest (PACKAGE_SPEC.md 4.1). Extends the current base with the new fields and is STRICT:
// an unknown field is an error (MANIFEST_UNKNOWN_FIELD). Platform v0 packages keep using `Manifest`.

export const DIFFERENTIATORS = ["tool", "verifier", "liveData", "memory", "escalation"] as const;
export type Differentiator = (typeof DIFFERENTIATORS)[number];

/** Accepted categories (list in the config; PACKAGE_SPEC.md 4.1). */
export const CATEGORIES = ["Desenvolvimento", "Design", "Dia a dia", "Negócios", "Jurídico", "Finanças", "Viagens", "Conteúdo", "Escrita", "Outros"] as const;

/** Categories third parties may NOT use in the Core phase (decision D13). */
export const NUCLEO_FORBIDDEN_CATEGORIES: readonly string[] = ["Jurídico", "Finanças"];

const Gate = z.union([
  z.string(),
  z.object({ text: z.string().min(2), evidence: z.object({ tool: z.string() }).strict() }).strict(),
]);

const Tool = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool name: lowercase letters, digits and _"),
    description: z.string(),
    runner: z.string(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    /** Only internal runners return `passed: boolean`; it counts as the success field for gates with evidence. */
    passField: z.string().optional(),
    http: z
      .object({
        method: z.enum(["GET", "POST"]),
        url: z.string(),
        allowedHosts: z.array(z.string()).min(1),
        headers: z.record(z.string()).optional(),
        timeoutMs: z.number().int().min(1000).max(20000).optional(),
      })
      .strict()
      .optional(),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
    egress: z.boolean().optional(),
  })
  .strict();

const Question = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    ask: z.string().min(10).max(200),
    why: z.string().min(10).max(200),
    options: z.array(z.string().min(1).max(80)).min(2).max(6).optional(),
  })
  .strict();

const TrialBase = ManifestBase.shape.trial.unwrap();

export const ManifestV1Base = ManifestBase.extend({
  specVersion: z.literal(1),
  /** Absent in the 1st version: the server assigns it and binds it to the creator's wallet. */
  id: z.string().regex(AGENT_ID_RE).optional(),
  steps: z.array(z.object({ file: z.string(), title: z.string().optional(), gate: z.array(Gate).default([]) }).strict()).min(1).max(12),
  tools: z.array(Tool).default([]),
  terms: z.object({ rightsConfirmed: z.boolean(), sourcesListed: z.boolean() }).strict().optional(),
  platform: z.boolean().optional(),
  knowledge: z
    .object({
      updatedAt: z.string(),
      reviewEveryDays: z.number().int().min(1).max(730),
      sources: z.array(z.string().min(2)).min(1),
    })
    .strict()
    .optional(),
  templates: z
    .array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), path: z.string(), title: z.string(), description: z.string() }).strict())
    .default([]),
  onboarding: z.object({ questions: z.array(Question).min(1).max(5) }).strict().optional(),
  escalation: z.object({ enabled: z.boolean() }).strict().optional(),
  differentiators: z.array(z.enum(DIFFERENTIATORS)).max(5).default([]),
  trial: TrialBase.extend({ templates: z.array(z.string()).default([]) }).optional(),
}).strict();

export type ManifestV1 = z.infer<typeof ManifestV1Base>;

/** Cross-field checks for v1 (the v0 ones plus trial templates). Codes are derived from the path (`path`). */
export function manifestV1CrossChecks(m: ManifestV1, ctx: z.RefinementCtx): void {
  if (!m.trial) return;
  if (m.trial.steps > m.steps.length) {
    ctx.addIssue({ code: "custom", path: ["trial", "steps"], message: `trial.steps (${m.trial.steps}) is greater than the number of steps (${m.steps.length})` });
  }
  for (const name of Object.keys(m.trial.tools)) {
    if (!m.tools.some((t) => t.name === name)) {
      ctx.addIssue({ code: "custom", path: ["trial", "tools", name], message: `trial.tools: tool "${name}" does not exist in tools` });
    }
  }
  for (const name of Object.keys(m.trial.toolLimits)) {
    if (!m.tools.some((t) => t.name === name)) {
      ctx.addIssue({ code: "custom", path: ["trial", "toolLimits", name], message: `trial.toolLimits: tool "${name}" does not exist in tools` });
    }
  }
  for (const name of m.trial.templates) {
    if (!m.templates.some((t) => t.name === name)) {
      ctx.addIssue({ code: "custom", path: ["trial", "templates", name], message: `trial.templates: template "${name}" does not exist in templates` });
    }
  }
}

export const ManifestV1 = ManifestV1Base.superRefine(manifestV1CrossChecks);
