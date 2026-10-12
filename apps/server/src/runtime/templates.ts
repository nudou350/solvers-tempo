import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ManifestExtras, TemplateDecl } from "./package-loader.js";
import { resolveInsidePackage } from "./package-paths.js";

// Package templates (PACKAGE_SPEC.md 7): `manifest.templates[]` declares name, path, title and description; anything
// not declared is not delivered. Core types: .md, .txt and .json (image, PDF and spreadsheet only through the site, in the
// Opening phase; .svg and .html are blocked). No env or database; tested in test/templates.test.ts.

export type { TemplateDecl } from "./package-loader.js";

/** Extensions the `get_template` tool delivers as text. */
export const TEMPLATE_TEXT_EXTS: readonly string[] = [".md", ".txt", ".json"];

/** Cap of a delivered template (they are short models; the same applies to the content that goes into the conversation). */
export const MAX_TEMPLATE_BYTES = 100_000;

/** The manifest can only list what the loader understands; the empty list is the default. */
export function declaredTemplates(m: Pick<ManifestExtras, "templates">): TemplateDecl[] {
  return m.templates ?? [];
}

/** Names unlocked in the free trial (`trial.templates`; none by default). */
export function trialTemplateNames(m: { trial?: { templates?: string[] } }): string[] {
  return m.trial?.templates ?? [];
}

/** Templates the session can see: all of them, or only those in `trial.templates` in a trial session. */
export function visibleTemplates(decls: readonly TemplateDecl[], trial: { templates: string[] } | null): TemplateDecl[] {
  return trial ? decls.filter((t) => trial.templates.includes(t.name)) : [...decls];
}

export type TemplateLookup =
  | { ok: true; decl: TemplateDecl }
  | { ok: false; reason: "none_declared" | "unknown" | "not_in_trial" | "type_not_allowed" };

/** Looks up the template by its declared name. Nothing outside `templates[]`, and in the trial only those in `trial.templates`. */
export function lookupTemplate(decls: readonly TemplateDecl[], name: string, trial: { templates: string[] } | null): TemplateLookup {
  if (decls.length === 0) return { ok: false, reason: "none_declared" };
  const decl = decls.find((t) => t.name === name);
  if (!decl) return { ok: false, reason: "unknown" };
  if (!TEMPLATE_TEXT_EXTS.includes(extname(decl.path).toLowerCase())) return { ok: false, reason: "type_not_allowed" };
  if (trial && !trial.templates.includes(decl.name)) return { ok: false, reason: "not_in_trial" };
  return { ok: true, decl };
}

/** Text for the AI when the request could not be served (the right name for the next call). */
export function templateProblemText(reason: Exclude<TemplateLookup, { ok: true }>["reason"], name: string, available: readonly TemplateDecl[]): string {
  const list = available.map((t) => t.name).join(", ");
  switch (reason) {
    case "none_declared":
      return "This specialist has no templates.";
    case "unknown":
      return `There is no template "${name}" for this specialist.${list ? ` Available: ${list}.` : ""}`;
    case "type_not_allowed":
      return `The template "${name}" is not a text file (.md, .txt or .json) and can't be delivered here.`;
    case "not_in_trial":
      return `The template "${name}" is not part of the free trial.${list ? ` Available in the trial: ${list}.` : ""}`;
  }
}

/** Overview section (activate_solver): the templates the session can request, and how many are license-only. */
export function templatesOverview(decls: readonly TemplateDecl[], trial: { templates: string[] } | null): string[] {
  if (decls.length === 0) return [];
  const visible = visibleTemplates(decls, trial);
  const locked = decls.length - visible.length;
  const lines = visible.map((t) => `- ${t.name}: ${t.title}. ${t.description}`);
  if (locked > 0) lines.push(`- (${locked} more ${locked === 1 ? "template" : "templates"} with the license only)`);
  if (visible.length === 0 && locked === 0) return [];
  return ["", "## Available templates (request the content with get_template)", ...lines];
}

/** Reads the template file from inside the package folder (path already contained by package-paths; UTF-8 text, capped). */
export function readTemplateFile(pkgDir: string, decl: TemplateDecl): string {
  const real = resolveInsidePackage(pkgDir, decl.path, ["templates/"]);
  const raw = readFileSync(real);
  if (raw.byteLength > MAX_TEMPLATE_BYTES) throw new Error(`template ${decl.name} exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

/** Tool response: the content stays intact (a .json remains valid) and the watermark goes outside it. */
export function renderTemplate(decl: TemplateDecl, content: string, watermark: string): string {
  const lang = extname(decl.path).toLowerCase() === ".json" ? "json" : "";
  // The fence grows until it no longer collides with backticks inside the content.
  let fence = "```";
  while (content.includes(fence)) fence += "`";
  return [`# Template: ${decl.title} (${decl.name})`, decl.description, "", `${fence}${lang}`, content.replace(/\s+$/, ""), fence, "", watermark].join("\n");
}
