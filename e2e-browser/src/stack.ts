// Mode A environment: the local QA stack of docs/qa.md §4 (anvil --tempo on 8545, QA API on 127.0.0.1:3028 with
// apps/server/.env.qa, database solvers_tempo_qa on the solvers-tempo-pg container) plus the web app in dev mode on 3001
// built with the dev wallet. What already runs is reused; what is missing is started and stopped at the end of the run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_QA, QA_API_URL, REPO, REPORT_DIR, WEB_URL } from "./env.js";
import { childEnv } from "../../scripts/src/env.js";

const ANVIL_RPC = "http://127.0.0.1:8545";
const SOLANA_PLATFORM_KEYPAIR = join(REPO, "apps", "server", ".keys", "solana-devnet-platform.json").replace(/\\/g, "/");
const QA_DB = "solvers_tempo_qa";
const PG_CONTAINER = "solvers-tempo-pg";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** True when the registry of deployments/31337.json has code on the running anvil (a restarted anvil has none). */
async function contractsDeployed(): Promise<boolean> {
  const file = join(REPO, "deployments", "31337.json");
  if (!existsSync(file)) return false;
  const registry = (JSON.parse(readFileSync(file, "utf8")) as { contracts?: { registry?: string }; registry?: string });
  const addr = registry.contracts?.registry ?? registry.registry;
  if (!addr) return false;
  const r = await json<{ result?: string }>(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] }) });
  return !!r?.result && r.result !== "0x";
}

async function anvilChainId(): Promise<number | null> {
  const r = await json<{ result?: string }>(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  return r?.result ? Number(r.result) : null;
}

type Cfg = { chainId: number; solanaPay?: { enabled: boolean; cluster: string }; pix: { enabled: boolean; simulate: boolean } };
const apiConfig = (base: string) => json<Cfg>(`${base}/api/config`);

/** Polls `fn`; stops at once when the process that should answer has exited (its log is in report/<name>.log). */
async function waitUntil(what: string, fn: () => Promise<boolean>, ms: number, child?: { proc: ChildProcess; log: string }): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    if (child && child.proc.exitCode !== null) throw new Error(`${what} exited with code ${child.proc.exitCode} before answering: see ${child.log}`);
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function log(text: string) {
  console.log(`[e2e-browser] ${text}`);
}

/** Runs a command to completion (inherits stdio); throws on a non-zero exit. */
export function runOrThrow(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

/**
 * The Solana Pay lines of .env.qa (docs/solana-pay.md): bootstrap.ts rewrites the file without them, so they are
 * appended when missing. Nothing else in the file is touched.
 */
export function ensureSolanaPayEnv(): boolean {
  const text = readFileSync(ENV_QA, "utf8");
  const want: Record<string, string> = { SOLANA_PAY_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_PAY_KEYPAIR: SOLANA_PLATFORM_KEYPAIR };
  const missing = Object.entries(want).filter(([k]) => !new RegExp(`^${k}=`, "m").test(text));
  if (missing.length === 0) return false;
  appendFileSync(ENV_QA, `${text.endsWith("\n") ? "" : "\n"}${missing.map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  log(`added ${missing.map(([k]) => k).join(", ")} to apps/server/.env.qa`);
  return true;
}

/** SQL on the QA database only (the disposable solvers_tempo_qa). */
export function qaSql(command: string): string {
  const r = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "solvers", "-d", QA_DB, "-v", "ON_ERROR_STOP=1", "-tA", "-c", command], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql on ${QA_DB} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export class LocalStack {
  private children: ChildProcess[] = [];

  /** Brings the stack up (bootstrap with `fresh`), reusing what already answers. */
  async up(o: { fresh: boolean }): Promise<void> {
    mkdirSync(REPORT_DIR, { recursive: true });
    const dbUp = spawnSync("docker", ["start", PG_CONTAINER], { encoding: "utf8" });
    if (dbUp.status !== 0) throw new Error(`docker start ${PG_CONTAINER} failed: ${dbUp.stderr}`);

    const apiRunning = (await apiConfig(QA_API_URL)) !== null;
    if (o.fresh || (await anvilChainId()) !== 31337 || !(await contractsDeployed()) || !existsSync(ENV_QA)) {
      if (apiRunning) throw new Error(`the QA API answers on ${QA_API_URL}: stop it before a fresh bootstrap (it would keep the old database connection and contracts)`);
      log("bootstrap: anvil --tempo, contracts, .env.qa, solvers_tempo_qa, seed");
      const foundry = join(homedir(), ".foundry", "bin");
      runOrThrow("npx", ["tsx", "src/bootstrap.ts", "--seed"], join(REPO, "scripts"), { ...process.env, PATH: `${process.env.PATH}${process.platform === "win32" ? ";" : ":"}${foundry}` });
    }
    const envChanged = ensureSolanaPayEnv();

    const cfg = await apiConfig(QA_API_URL);
    if (cfg && envChanged) throw new Error(`apps/server/.env.qa gained the Solana Pay lines: restart the QA API on ${QA_API_URL}`);
    if (!cfg) {
      log(`starting the QA API (${QA_API_URL}, apps/server/.env.qa)`);
      const api = this.start("qa-api", process.execPath, ["--env-file=.env.qa", "--import", "tsx", "src/index.ts"], join(REPO, "apps", "server"), childEnv(ENV_QA, { qa: true }));
      await waitUntil("the QA API", async () => (await apiConfig(QA_API_URL)) !== null, 180_000, api);
    }
    const c = (await apiConfig(QA_API_URL))!;
    if (c.chainId !== 31337) throw new Error(`the API on ${QA_API_URL} serves chain ${c.chainId}, not the local QA chain 31337`);
    if (!c.solanaPay?.enabled || c.solanaPay.cluster !== "devnet") throw new Error(`Solana Pay is not enabled on devnet in the QA API (restart it after .env.qa changes)`);
    if (!c.pix.enabled || !c.pix.simulate) throw new Error("Pix (simulated) is not enabled in the QA API");

    const web = await apiConfig(WEB_URL);
    if (!web) {
      log(`starting the web app (${WEB_URL}, dev wallet on, API ${QA_API_URL})`);
      const port = new URL(WEB_URL).port || "3001";
      if (port !== "3001") throw new Error("the web dev server runs on port 3001 (apps/web package.json)");
      const web = this.start("web", "pnpm", ["--filter", "@solvers/web", "dev"], REPO, {
        ...process.env,
        // The owner's command line for mode A. Only Privy reads the build chain id (Privy is off here: no app id); the dev
        // wallet signs for the chain the API reports (31337), and refuses only mainnet.
        NEXT_PUBLIC_CHAIN_ID: "42431",
        NEXT_PUBLIC_ALLOW_DEV_WALLET: "1",
        NEXT_PUBLIC_PRIVY_APP_ID: "",
        // Same origin: the browser's API calls go through the dev rewrites to API_DEV_URL, never to another API.
        NEXT_PUBLIC_API_URL: "",
        API_INTERNAL_URL: QA_API_URL,
        API_DEV_URL: QA_API_URL.replace("127.0.0.1", "localhost"),
      });
      await waitUntil("the web app", async () => (await apiConfig(WEB_URL)) !== null, 180_000, web);
    }
    const proxied = await apiConfig(WEB_URL);
    if (proxied?.chainId !== 31337) throw new Error(`${WEB_URL} proxies to an API on chain ${proxied?.chainId}: it must be the QA API (restart the web dev server with API_DEV_URL=${QA_API_URL})`);
  }

  /** First requests compile each page in dev mode (~30 s each): done once here, not inside test timeouts. */
  async warmUp(paths: string[]): Promise<void> {
    log(`warming up ${paths.length} pages`);
    await Promise.all(paths.map((p) => fetch(`${WEB_URL}${p}`, { signal: AbortSignal.timeout(300_000) }).catch(() => undefined)));
  }

  private start(name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { proc: ChildProcess; log: string } {
    const log = join(REPORT_DIR, `${name}.log`);
    const out = openSync(log, "w");
    const proc = spawn(cmd, args, { cwd, env, stdio: ["ignore", out, out], shell: process.platform === "win32" && cmd === "pnpm" });
    // A spawn failure is reported by waitUntil (exitCode), never as an unhandled 'error' event that skips down().
    proc.on("error", (e) => console.error(`[e2e-browser] ${name} could not start: ${e.message}`));
    this.children.push(proc);
    return { proc, log };
  }

  /** Stops what this run started (never what was already running). */
  down(): void {
    for (const c of this.children) {
      if (c.pid === undefined || c.exitCode !== null) continue;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    }
  }
}
