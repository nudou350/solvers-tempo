import { zodToJsonSchema } from "zod-to-json-schema";
import { ManifestV1Base } from "./schema-v1.js";

// JSON Schema of the v1 manifest (PACKAGE_SPEC.md 13), generated from zod: editors and the Solver Creator use this
// file only for autocompletion/explanations; the validator always decides whether a package is valid.
// Served at GET /api/spec/manifest.schema.json (route in P4) and written by `npm run cli:schema`.

export function manifestJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ManifestV1Base, { name: "SolverManifestV1", $refStrategy: "none" }) as Record<string, unknown>;
  return { $schema: "http://json-schema.org/draft-07/schema#", title: "Solver package manifest (specVersion 1)", ...schema };
}
