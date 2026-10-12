// Mode and URLs of the browser e2e (docs/browser-e2e-plan.md §3). Imported FIRST by every module that loads the scripts
// helpers (scripts/src/env.ts reads API_URL and SERVER_ENV_FILE when it is evaluated).
//
//   E2E_MODE      local (default: local QA stack, dev wallet) | prod (public testnet site, the owner's Privy account)
//   E2E_WEB_URL   web app under test (local default http://localhost:3001)
//   API_URL       API the chain checks talk to (local default: the QA API on 127.0.0.1:3028; prod: the site itself)
//   E2E_PROD_EMAIL  the owner's Privy e-mail, required in prod mode (kept out of the repository)
import { join, resolve } from "node:path";

export const MODE: "local" | "prod" = process.env.E2E_MODE === "prod" ? "prod" : "local";
export const IS_PROD = MODE === "prod";

export const REPO = resolve(import.meta.dirname, "..", "..");
export const E2E_DIR = join(REPO, "e2e-browser");
export const ENV_QA = join(REPO, "apps", "server", ".env.qa");
/** Playwright storage state of the owner's Privy session (gitignored, never printed). */
export const PROD_AUTH_FILE = join(E2E_DIR, ".auth", "prod.json");
/** Run artefacts: HTML report, JSON results, transaction summary. */
export const REPORT_DIR = join(E2E_DIR, "report");

export const PROD_URL = "https://solvers-tempo.wondervelop.com";
export const QA_API_URL = "http://127.0.0.1:3028";
export const WEB_URL = (process.env.E2E_WEB_URL ?? (IS_PROD ? PROD_URL : "http://localhost:3001")).replace(/\/$/, "");

/** The owner's account used in mode B (plan §3). The e-mail comes from the environment, never from the repository. */
export const PROD_EMAIL = process.env.E2E_PROD_EMAIL ?? "";
if (IS_PROD && !PROD_EMAIL) throw new Error("E2E_MODE=prod needs E2E_PROD_EMAIL (the owner's Privy e-mail)");
export const PROD_WALLET = "0x6e3e7bf4047d70f853b7c26acee15eb8387663f8";

// Pinned, not defaulted: a shell left with the dev values (API_URL=…:3018, CHAIN_ID=42431, SERVER_ENV_FILE=.env) would
// otherwise make the chain checks read another network than the site under test uses.
process.env.API_URL = IS_PROD ? PROD_URL : QA_API_URL;
process.env.CHAIN_ID = IS_PROD ? "42431" : "31337";
// Local: RPC_URL comes from .env.qa (scripts/src/env.ts reads it from SERVER_ENV_FILE); prod: the public Moderato RPC.
// Both use the repository's deployments/<chainId>.json.
delete process.env.RPC_URL;
delete process.env.DEPLOYMENTS_FILE;
if (IS_PROD) delete process.env.SERVER_ENV_FILE;
else process.env.SERVER_ENV_FILE = ENV_QA;
