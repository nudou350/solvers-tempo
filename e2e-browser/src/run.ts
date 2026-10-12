// Runs the browser e2e on demand (docs/browser-e2e-plan.md §6 phase 5; never scheduled):
//
//   pnpm e2e:browser [--fresh] [--keep] [playwright args...]     mode A: local QA stack, dev wallet (serial by default)
//   pnpm e2e:browser --prod [playwright args...]                 mode B: public testnet site, the owner's account, serial
//
//   --fresh   re-run scripts/src/bootstrap.ts --seed first (new anvil contracts, new solvers_tempo_qa); the QA API must
//             be stopped
//   --keep    leave the QA API and the web dev server running when this run started them
// Anything else goes to `playwright test` (e.g. a file name, -g "scenario 3", --headed).
// E2E_TELEGRAM=1 with TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID also sends the summary to Telegram.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const prod = has("--prod");
// Before anything reads the environment (src/env.ts reads E2E_MODE when it is first imported).
process.env.E2E_MODE = prod ? "prod" : "local";
const passThrough = argv.filter((a) => !["--prod", "--fresh", "--keep", "--"].includes(a));

const { E2E_DIR, IS_PROD } = await import("./env.js");
const { LocalStack, qaSql } = await import("./stack.js");
const { prepareLocal, prepareProd } = await import("./prepare.js");
const { notifyTelegram } = await import("./notify.js");

// A summary from an earlier run must never be reported (or sent to Telegram) as this one's.
rmSync(join(E2E_DIR, "report", "summary.json"), { force: true });
rmSync(join(E2E_DIR, "report", "summary.md"), { force: true });

const stack = IS_PROD ? null : new LocalStack();
let code = 1;
try {
  if (stack) {
    await stack.up({ fresh: has("--fresh") });
    // The faucet allows one request per wallet per hour and per IP per 10 minutes: the QA database is disposable, so its
    // cooldowns are cleared for each run (scenario 2 uses the faucet button).
    qaSql("delete from kv where key like 'faucet:%'");
    await prepareLocal();
    await stack.warmUp(["/en", "/pt", "/en/library", "/en/checkout?agent=frontend-react&type=license", "/en/checkout/done", "/en/install", "/en/guarantees", "/en/creator", "/en/profile"]);
  } else {
    await prepareProd();
  }
  // Without a shell: arguments such as -g "scenario 3" reach Playwright intact on Windows.
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const r = spawnSync(process.execPath, [cli, "test", ...passThrough], { cwd: E2E_DIR, stdio: "inherit", env: process.env });
  code = r.status ?? 1;
} catch (e) {
  console.error(`[e2e-browser] ${(e as Error).message}`);
} finally {
  if (stack && !has("--keep")) stack.down();
}
await notifyTelegram(IS_PROD ? "public testnet site" : "local QA stack");
console.log(`[e2e-browser] report: ${join(E2E_DIR, "report", "summary.md")}`);
process.exit(code);
