// Preparation before Playwright starts: test data of the local QA stack (mode A) and test funds of the owner's wallet
// (mode B). Runs in the runner process (src/run.ts), never inside a test.
import "./env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address } from "viem";
import { setSupplyCapCalls } from "@solvers/chain";
import { agentIdToBytes32 } from "@solvers/shared";
import { freshAccount, namedAccount } from "../../scripts/src/env.js";
import { buyLicense } from "../../scripts/src/lib/flows.js";
import { cli } from "../../scripts/src/lib/qa-env.js";
import { TestWallet } from "../../scripts/src/lib/wallet.js";
import { agentDetail, chainAgent, fmt, fund, getConfig, network, tokenBalance, units, waitFor } from "./chain.js";
import { E2E_DIR, ENV_QA, PROD_WALLET, QA_API_URL, REPO, WEB_URL } from "./env.js";

function log(text: string) {
  console.log(`[e2e-browser] ${text}`);
}

/** Test Solvers of the local QA stack, created once and reused while they stay valid (`.cache/`, gitignored). */
export type QaFixtures = {
  /** A Solver at the minimum price (5 USD), published through the real creator flow (scripts/src/publish-test-agent.ts). */
  cheap: { slug: string; id: string };
  /** A test Solver whose license cap equals its sales (set by its creator on-chain): sold out. */
  soldOut: { slug: string; id: string };
  /** A test Solver suspended by the admin kill switch (cli:suspend: database + suspendAgent on-chain). */
  suspended: { slug: string; id: string };
};

export const QA_FIXTURES_FILE = join(E2E_DIR, ".cache", "qa-fixtures.json");

/** The fixtures written by prepareLocal (tests call this; it throws when the runner did not prepare them). */
export function qaFixtures(): QaFixtures {
  if (!existsSync(QA_FIXTURES_FILE)) throw new Error(`${QA_FIXTURES_FILE} is missing: run the suite through \`pnpm e2e:browser\``);
  return JSON.parse(readFileSync(QA_FIXTURES_FILE, "utf8")) as QaFixtures;
}

/**
 * Publishes one 5-USD test Solver through the creator flow and makes sure it has one sale; returns its slug.
 * publish-test-agent.ts checks the submission right after cli:approve and sometimes still sees `publishing` (the indexer
 * finishes the publication a moment later): that one failure is tolerated when the Solver then turns active on chain.
 */
async function publishTestSolver(): Promise<string> {
  log("publishing a 5 USD test Solver through the creator flow (publish-test-agent.ts)");
  const r = spawnSync("npx", ["tsx", "src/publish-test-agent.ts"], {
    cwd: join(REPO, "scripts"),
    env: { ...process.env, API_URL: QA_API_URL, SERVER_ENV_FILE: ENV_QA },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 600_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const slug = /\((e2e-[0-9a-f]{6}) v\d/.exec(out)?.[1];
  const racedOnPublishing = /FAIL {2}cli:approve[^\n]*\n[^\n]*expected "published", got "publishing"/.test(out);
  if (!slug || (r.status !== 0 && !racedOnPublishing)) throw new Error(`publish-test-agent failed (exit ${r.status}):\n${out.slice(-2000)}`);
  if (r.status !== 0) log(`${slug}: publish-test-agent saw "publishing" right after cli:approve; waiting for the publication to finish`);
  const active = await waitFor(`${slug} active on chain and listed`, async () => {
    const d = await agentDetail(slug).catch(() => null);
    return d && (await chainAgent(d.agent.id)).status === 1 ? d : null;
  }, 90_000);
  if ((await chainAgent(active.agent.id)).totalSales === 0) {
    // The script stopped before its purchase: one sale through the API (sold-out needs a cap >= 1 sale).
    const buyer = await new TestWallet(freshAccount(), "buyer").login();
    await fund(buyer.address, units(5));
    await buyLicense(buyer, active.agent.id, units(5));
  }
  return slug;
}

/** An active (on-chain status 1) Solver of the API at the minimum price, or null. */
async function validCheap(slug: string | undefined): Promise<{ slug: string; id: string } | null> {
  if (!slug) return null;
  try {
    const d = await agentDetail(slug);
    const c = await chainAgent(d.agent.id);
    return c.status === 1 && c.price === units(5) && c.maxSupply === 0 ? { slug, id: d.agent.id } : null;
  } catch {
    return null;
  }
}

/**
 * The chain checks read the network the site under test serves: the RPC's chain id (scripts' network()), the API the
 * checks call and the API behind the web app (/api/config through the site) must all agree.
 */
async function assertSameNetwork(): Promise<void> {
  const n = await network();
  const api = (await getConfig()).chainId;
  const site = ((await (await fetch(`${WEB_URL}/api/config`)).json()) as { chainId: number }).chainId;
  if (n.chainId !== api || api !== site) throw new Error(`network mismatch: RPC ${n.chainId}, API ${api}, site ${site}`);
  log(`network ${n.chainId}: RPC ${n.rpcUrl}, registry ${n.deployment.registry}`);
}

type Ref = { slug: string; id: string };

/** Sold out: on-chain cap = sales (> 0) and the API mirror says 0 left. */
async function validSoldOut(slug: string | undefined): Promise<Ref | null> {
  if (!slug) return null;
  try {
    const d = await agentDetail(slug);
    const c = await chainAgent(d.agent.id);
    const supply = (d.agent as unknown as { supply?: { left: number | null } }).supply;
    return c.status === 1 && c.maxSupply > 0 && c.totalSales >= c.maxSupply && supply?.left === 0 ? { slug, id: d.agent.id } : null;
  } catch {
    return null;
  }
}

/** The creator of a published test Solver (key kept by publish-test-agent) caps it at its current sales. */
async function makeSoldOut(slug: string): Promise<Ref> {
  const d = await agentDetail(slug);
  const c = await chainAgent(d.agent.id);
  const creator = await new TestWallet(namedAccount(`creators/${slug}`), "creator").login();
  if (creator.lower !== c.creator.toLowerCase()) throw new Error(`scripts/.keys/creators/${slug}.key is not the creator of ${slug}`);
  const n = await network();
  await creator.sendAndConfirm(setSupplyCapCalls(n.deployment, { agentId: agentIdToBytes32(d.agent.id), max: c.totalSales }));
  await waitFor(`${slug} sold out in the API`, () => validSoldOut(slug), 60_000);
  return { slug, id: d.agent.id };
}

/** Suspended: on-chain status Suspended (2) and gone from the catalog list. */
async function validSuspended(ref: Ref | undefined): Promise<Ref | null> {
  if (!ref) return null;
  try {
    const c = await chainAgent(ref.id);
    return c.status === 2 ? ref : null;
  } catch {
    return null;
  }
}

async function makeSuspended(slug: string): Promise<Ref> {
  const d = await agentDetail(slug);
  const r = cli("suspend", [slug, "--reason", "browser e2e: suspended test Solver"]);
  if (r.code !== 0) throw new Error(`cli:suspend ${slug} failed:
${r.out.slice(-1500)}`);
  const ref = { slug, id: d.agent.id };
  if (!(await validSuspended(ref))) throw new Error(`${slug} is not suspended on-chain after cli:suspend`);
  return ref;
}

/** Mode A: the test Solvers the scenarios need (reused across runs while the QA stack keeps them). */
export async function prepareLocal(): Promise<QaFixtures> {
  await assertSameNetwork();
  const old = existsSync(QA_FIXTURES_FILE) ? (JSON.parse(readFileSync(QA_FIXTURES_FILE, "utf8")) as Partial<QaFixtures>) : {};
  const cheap = (await validCheap(old.cheap?.slug)) ?? (await validCheap(await publishTestSolver()));
  if (!cheap) throw new Error("the published test Solver is not active at 5 USD");
  const soldOut = (await validSoldOut(old.soldOut?.slug)) ?? (await makeSoldOut(await publishTestSolver()));
  const suspended = (await validSuspended(old.suspended)) ?? (await makeSuspended(await publishTestSolver()));
  const fx: QaFixtures = { cheap, soldOut, suspended };
  mkdirSync(dirname(QA_FIXTURES_FILE), { recursive: true });
  writeFileSync(QA_FIXTURES_FILE, JSON.stringify(fx, null, 2));
  log(`test Solvers: cheap ${cheap.slug}, sold out ${soldOut.slug}, suspended ${suspended.slug}`);
  // Server-rendered pages use API_INTERNAL_URL, not the rewrites: a Solver that exists only in the QA database proves
  // that a reused web server renders from the QA API too.
  const ssr = await fetch(`${WEB_URL}/en/solvers/${cheap.slug}`, { signal: AbortSignal.timeout(300_000) });
  if (ssr.status !== 200) throw new Error(`${WEB_URL}/en/solvers/${cheap.slug} answered ${ssr.status}: the web server renders from another API than ${QA_API_URL} (API_INTERNAL_URL)`);
  return fx;
}

/** Mode B: the owner's wallet holds enough test stablecoin for the purchases of the run (Moderato faucet). */
export async function prepareProd(): Promise<void> {
  await assertSameNetwork();
  const need = units(100);
  const before = await tokenBalance(PROD_WALLET as Address);
  if (before < need) {
    log(`funding ${PROD_WALLET} from the Moderato faucet (balance ${fmt(before)})`);
    await fund(PROD_WALLET as Address, need);
  }
  log(`owner wallet balance: ${fmt(await tokenBalance(PROD_WALLET as Address))}`);
}
