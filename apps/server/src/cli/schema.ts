import { writeFileSync } from "node:fs";
import { manifestJsonSchema } from "../runtime/validate/json-schema.js";

// Generates the JSON Schema of the v1 manifest (PACKAGE_SPEC.md 13).
//   npm run cli:schema                      # prints to the terminal
//   npm run cli:schema -- manifest.schema.json   # writes to the file

const out = process.argv[2];
const json = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
if (out) {
  writeFileSync(out, json);
  console.log(`schema written to ${out}`);
} else {
  process.stdout.write(json);
}
