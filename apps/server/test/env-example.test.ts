// infra/.env.example documents every variable validated by src/env.ts, and nothing else.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// env.ts validates process.env on import: provide the two required secrets first.
process.env.JWT_SECRET ??= "j".repeat(40);
process.env.SERVER_KEK ??= Buffer.alloc(32, 7).toString("base64");

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("infra/.env.example", () => {
  const envKeys = [...read("../src/env.ts").matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
  const example = read("../../../infra/.env.example");
  const exampleKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);

  it("lists every variable of env.ts", () => {
    assert.ok(envKeys.length > 50, "env.ts keys were parsed");
    assert.deepEqual(envKeys.filter((k) => !exampleKeys.includes(k)), []);
  });

  it("lists nothing env.ts does not know", () => {
    assert.deepEqual(exampleKeys.filter((k) => !envKeys.includes(k)), []);
  });

  it("parses as shipped once the required secrets are filled in (empty lines count as unset)", async () => {
    const source: NodeJS.ProcessEnv = {};
    for (const m of example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) source[m[1]!] = m[2]!.trim();
    Object.assign(source, { JWT_SECRET: "j".repeat(40), SERVER_KEK: Buffer.alloc(32, 7).toString("base64") });
    const { loadEnv } = await import("../src/env.js");
    const e = loadEnv(source);
    assert.equal(e.CHAIN_ID, 42431);
    assert.equal(e.PIX_SIMULATE, true, "empty PIX_SIMULATE = default (true off mainnet)");
    assert.equal(e.RELAY_DAILY_GAS_GLOBAL, 2_000_000_000n);
  });

  it("ships no secret values", () => {
    for (const k of ["PLATFORM_PRIVATE_KEY", "RELAY_PRIVATE_KEY", "VERIFIER_PRIVATE_KEY", "ADMIN_PRIVATE_KEY", "JWT_SECRET", "SERVER_KEK", "MPP_SECRET_KEY", "MP_ACCESS_TOKEN"]) {
      assert.match(example, new RegExp(`^${k}=$`, "m"), `${k} must be empty`);
    }
  });
});
