// The local QA environment (scripts/src/bootstrap.ts): `anvil --tempo` on 8545, the QA API on 127.0.0.1:3028 and the
// disposable database solvers_tempo_qa on the solvers-tempo-pg container (port 5546). Helpers shared by e2e-creator,
// qa-race and qa-worker-resume: SQL through `docker exec psql`, the server CLIs run with apps/server/.env.qa, and the
// anvil dev keys of the QA roles.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, SERVER_DIR, childEnv } from "../env.js";

export const QA_API_PORT = 3028;
export const QA_API_URL = `http://127.0.0.1:${QA_API_PORT}`;
export const QA_DB = "solvers_tempo_qa";
export const PG_CONTAINER = process.env.PG_CONTAINER ?? "solvers-tempo-pg";
export const PG_USER = process.env.PG_USER ?? "solvers";
export const ENV_QA = join(SERVER_DIR, ".env.qa");
export const QA_DATA = join(SERVER_DIR, ".qa-data");
export const ANVIL_PORT = 8545;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
export const DEPLOYMENT_FILE = join(ROOT, "deployments", "31337.json");

/** Public anvil dev keys (mnemonic "test test ... junk"): never secrets, never used outside the local chain. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  platform: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  verifier: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  admin: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  relay: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
} as const satisfies Record<string, Hex>;

export const qaAdmin = () => privateKeyToAccount(ANVIL_KEYS.admin);

/** Refuses anything but a local API: the QA scripts write to the server's database. */
export function requireLocalApi(url: string): void {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error(`API_URL must be local (got ${url}): this QA writes to the server's database.`);
}

/** Runs a query on the QA database and returns the rows (json_agg). */
export function sql<T = any>(query: string): T[] {
  const out = execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", QA_DB, "-tA", "-c", `select coalesce(json_agg(t),'[]'::json) from (${query}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim()) as T[];
}

/** A command that may fail (to prove the database refuses it). */
export function sqlRaw(command: string): { ok: boolean; out: string } {
  const r = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", QA_DB, "-v", "ON_ERROR_STOP=1", "-c", command], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** Environment of every QA child process: .env.qa values set explicitly (the shell cannot override them), QA DB only. */
export const qaChildEnv = (extra?: Record<string, string>) => childEnv(ENV_QA, { qa: true, extra });

/** Runs a server CLI ALWAYS with .env.qa (never .env, which points to the dev database). */
export function cli(name: string, args: string[] = [], timeout = 300_000): { code: number; out: string } {
  const r = spawnSync("node", [`--env-file=${ENV_QA}`, "--import", "tsx", `src/cli/${name}.ts`, ...args], { cwd: SERVER_DIR, env: qaChildEnv(), encoding: "utf8", timeout });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
