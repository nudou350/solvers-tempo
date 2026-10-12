// Local QA environment on `anvil --tempo` (plan §6 phase 6): chain, contracts, server env, disposable database, seed.
//
//   cd scripts && npx tsx src/bootstrap.ts [--seed] [--skip-deploy]
//
// 1. Starts a detached, long-running `anvil --tempo --port 8545` (kept running for every later script; reused when a
//    chain 31337 already answers there).
// 2. Deploys the six proxies with the production forge scripts, like contracts/script/e2e-anvil.sh: `forge clean`,
//    Deploy.s.sol (deployer = dev key 0, PLATFORM 1, VERIFIER 2, cold admin 3, treasury 0x...dEaD, MIN_STAKE 0), then
//    AcceptAdmin.s.sol signed by the cold admin. Writes deployments/31337.json. `--skip-deploy` reuses that file.
// 3. Writes apps/server/.env.qa (gitignored): API on 127.0.0.1:3028, database solvers_tempo_qa on 5546, anvil keys
//    (RELAY = dev key 8, no role), submissions inline, simulated verifier, guarantees open (min sales/rating 0),
//    agent payments on with a random MPP secret.
// 4. Recreates the database solvers_tempo_qa on the solvers-tempo-pg container and migrates it (never touches
//    solvers_tempo or solvers_tempo_test, nor ports 5433/5543/5544).
// 5. `--seed`: `cli:publish --no-chain` (criador-de-solvers) and `cli:publish frontend-react ui-design` (on anvil).
//
// Then: cd apps/server && node --env-file=.env.qa --import tsx src/index.ts
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, SERVER_DIR, sleep } from "./env.js";
import { ANVIL_KEYS, ANVIL_PORT, ANVIL_RPC, DEPLOYMENT_FILE, ENV_QA, PG_CONTAINER, PG_USER, QA_API_PORT, QA_DATA, QA_DB, cli, qaChildEnv } from "./lib/qa-env.js";

const args = process.argv.slice(2);
const SEED = args.includes("--seed");
const SKIP_DEPLOY = args.includes("--skip-deploy");
const exe = process.platform === "win32" ? ".exe" : "";
const foundry = (name: string) => {
  const local = join(homedir(), ".foundry", "bin", `${name}${exe}`);
  return existsSync(local) ? local : name;
};
const CONTRACTS = join(ROOT, "contracts");
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const addr = (k: `0x${string}`) => privateKeyToAccount(k).address;

function step(title: string) {
  console.log(`\n== ${title}`);
}

/** `env` adds to the inherited environment; `fullEnv` replaces it (server children: see childEnv in env.ts). */
function run(cmd: string, argv: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; fullEnv?: NodeJS.ProcessEnv; timeout?: number; quiet?: boolean } = {}): string {
  const r = spawnSync(cmd, argv, { cwd: o.cwd, env: o.fullEnv ?? { ...process.env, ...o.env }, encoding: "utf8", timeout: o.timeout ?? 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} failed (${r.status ?? r.error?.message}):\n${out.slice(-3000)}`);
  if (!o.quiet) process.stdout.write(out.split("\n").slice(-6).join("\n"));
  return out;
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function anvilChainId(): Promise<number | null> {
  try {
    return Number(await rpc("eth_chainId"));
  } catch {
    return null;
  }
}

// ---------- 1. anvil ----------
step(`anvil --tempo on ${ANVIL_RPC}`);
let anvilPid: number | undefined;
const existing = await anvilChainId();
if (existing !== null) {
  if (existing !== 31337) throw new Error(`port ${ANVIL_PORT} answers chain ${existing}, not a local anvil: stop it or change the port`);
  console.log("already running (chain 31337): reused (its state is kept)");
} else {
  const child = spawn(foundry("anvil"), ["--tempo", "--port", String(ANVIL_PORT), "--silent"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  anvilPid = child.pid;
  for (let i = 0; i < 100 && (await anvilChainId()) === null; i++) await sleep(200);
  if ((await anvilChainId()) !== 31337) throw new Error("anvil did not start");
  console.log(`started (pid ${anvilPid}); stop it with: ${process.platform === "win32" ? `Stop-Process -Id ${anvilPid}` : `kill ${anvilPid}`}`);
}

// ---------- 2. contracts ----------
if (!SKIP_DEPLOY) {
  step("deploy (forge clean + Deploy.s.sol + AcceptAdmin.s.sol)");
  // openzeppelin-foundry-upgrades validation needs exactly one build-info per contract: start from a clean out/.
  run(foundry("forge"), ["clean"], { cwd: CONTRACTS, quiet: true });
  run(
    foundry("forge"),
    ["script", "script/Deploy.s.sol", "--skip", "test", "--rpc-url", ANVIL_RPC, "--broadcast", "--private-key", ANVIL_KEYS.deployer],
    {
      cwd: CONTRACTS,
      quiet: true,
      env: {
        PAYMENT_TOKEN: "0x20c0000000000000000000000000000000000000",
        TREASURY_ADDRESS: TREASURY,
        PLATFORM_ADDRESS: addr(ANVIL_KEYS.platform),
        VERIFIER_ADDRESS: addr(ANVIL_KEYS.verifier),
        COLD_ADMIN: addr(ANVIL_KEYS.admin),
        MIN_STAKE: "0",
        LICENSE_BASE_URI: `http://127.0.0.1:${QA_API_PORT}/api/license/`,
        DEPLOYMENT_NAME: "anvil",
      },
    },
  );
  const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, string>;
  await rpc("evm_increaseTime", [2]);
  await rpc("evm_mine");
  run(foundry("forge"), ["script", "script/AcceptAdmin.s.sol", "--skip", "test", "--rpc-url", ANVIL_RPC, "--broadcast", "--private-key", ANVIL_KEYS.admin], {
    cwd: CONTRACTS,
    quiet: true,
    env: { REGISTRY: d.registry },
  });
  console.log(`registry ${d.registry}, license ${d.license}; admin accepted by ${addr(ANVIL_KEYS.admin)}`);
} else if (!existsSync(DEPLOYMENT_FILE)) {
  throw new Error(`--skip-deploy needs ${DEPLOYMENT_FILE}`);
}

// ---------- 3. apps/server/.env.qa ----------
step(`apps/server/.env.qa (API on 127.0.0.1:${QA_API_PORT}, database ${QA_DB})`);
const keep = existsSync(ENV_QA) ? readFileSync(ENV_QA, "utf8") : "";
const kept = (k: string) => new RegExp(`^${k}=(.+)$`, "m").exec(keep)?.[1];
const qaData = (d: string) => join(QA_DATA, d).replace(/\\/g, "/");
const envQa: Record<string, string> = {
  NODE_ENV: "development",
  PORT: String(QA_API_PORT),
  PUBLIC_API_URL: `http://127.0.0.1:${QA_API_PORT}`,
  PUBLIC_WEB_URL: "http://localhost:3001",
  SIWE_DOMAINS: `127.0.0.1:${QA_API_PORT},localhost:${QA_API_PORT},localhost:3001`,
  DATABASE_URL: `postgres://solvers:solvers@127.0.0.1:5546/${QA_DB}`,
  CHAIN_ID: "31337",
  RPC_URL: ANVIL_RPC,
  DEPLOYMENTS_FILE: DEPLOYMENT_FILE.replace(/\\/g, "/"),
  PAYMENT_TOKEN: "0x20c0000000000000000000000000000000000000",
  PAYMENT_TOKEN_DECIMALS: "6",
  PAYMENT_TOKEN_SYMBOL: "USD",
  PLATFORM_PRIVATE_KEY: ANVIL_KEYS.platform,
  RELAY_PRIVATE_KEY: ANVIL_KEYS.relay,
  VERIFIER_PRIVATE_KEY: ANVIL_KEYS.verifier,
  ADMIN_PRIVATE_KEY: ANVIL_KEYS.admin,
  TREASURY_ADDRESS: TREASURY,
  ADMIN_WALLETS: addr(ANVIL_KEYS.admin).toLowerCase(),
  JWT_SECRET: kept("JWT_SECRET") ?? randomBytes(32).toString("hex"),
  SERVER_KEK: kept("SERVER_KEK") ?? randomBytes(32).toString("base64"),
  FAUCET_ENABLED: "true",
  SUBMISSIONS_INLINE: "true",
  VERIFIER_MODE: "simulated",
  GUARANTEE_MIN_SALES: "0",
  GUARANTEE_MIN_RATING: "0",
  AGENT_PAY_ENABLED: "true",
  MPP_SECRET_KEY: kept("MPP_SECRET_KEY") ?? randomBytes(32).toString("hex"),
  SUBMISSIONS_DIR: qaData("submissions"),
  PUBLISHED_DIR: qaData("packages"),
  DELIVERABLES_DIR: qaData("deliverables"),
  INDEXER_START_BLOCK: "0",
  INDEXER_CONFIRMATIONS: "0",
  RATE_LIMIT_PER_MINUTE: "600",
  // The creator QA uploads ~25 ZIPs per run; the per-creator pending limit (3) stays at its default and is tested.
  SUBMISSION_MAX_PER_DAY: "500",
};
writeFileSync(
  ENV_QA,
  `# Local QA environment written by scripts/src/bootstrap.ts (anvil --tempo, public dev keys). Gitignored. Never point it at a real database.\n${Object.entries(envQa)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`,
  { mode: 0o600 },
);
console.log(`written ${ENV_QA}`);

// ---------- 4. database ----------
step(`database ${QA_DB} on ${PG_CONTAINER} (5546)`);
const psql = (c: string) => run("docker", ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", c], { quiet: true });
psql(`DROP DATABASE IF EXISTS ${QA_DB} WITH (FORCE)`);
psql(`CREATE DATABASE ${QA_DB}`);
run("docker", ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", QA_DB, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"], { quiet: true });
// The migration gets .env.qa's values explicitly (a DATABASE_URL in the shell would win over --env-file) and refuses
// anything but the QA database on 5546.
run("node", [`--env-file=${ENV_QA}`, "--import", "tsx", "src/db/migrate.ts"], { cwd: SERVER_DIR, fullEnv: qaChildEnv() });
for (const d of ["submissions", "packages", "deliverables"]) {
  rmSync(join(QA_DATA, d), { recursive: true, force: true });
  mkdirSync(join(QA_DATA, d), { recursive: true });
}
rmSync(join(QA_DATA, "e2e-state.json"), { force: true });
console.log("\nrecreated, migrated; .qa-data folders emptied");

// ---------- 5. seed ----------
if (SEED) {
  step("seed: cli:publish --no-chain, cli:publish frontend-react ui-design");
  for (const a of [["--no-chain"], ["frontend-react", "ui-design"]]) {
    const r = cli("publish", a, 900_000);
    console.log(r.out.split("\n").slice(-12).join("\n"));
    if (r.code !== 0) throw new Error(`cli:publish ${a.join(" ")} failed (${r.code})`);
  }
}

console.log(`
Local QA environment ready.
  anvil:    ${ANVIL_RPC}${anvilPid ? ` (pid ${anvilPid})` : ""}
  API:      cd apps/server && node --env-file=.env.qa --import tsx src/index.ts      (http://127.0.0.1:${QA_API_PORT})
  scripts:  cd scripts && API_URL=http://127.0.0.1:${QA_API_PORT} SERVER_ENV_FILE=../apps/server/.env.qa npx tsx src/e2e-creator.ts
`);
process.exit(0);
