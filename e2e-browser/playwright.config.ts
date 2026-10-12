// Browser e2e (docs/browser-e2e-plan.md). Run it through `pnpm e2e:browser` (mode A, local QA stack) or
// `pnpm e2e:browser --prod` (mode B, the public testnet site), which prepare the environment first (src/run.ts).
import "./src/env.js";
import { defineConfig, devices } from "@playwright/test";
import { IS_PROD, PROD_AUTH_FILE, WEB_URL } from "./src/env.js";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./report/test-results",
  // On-chain waits (relay, indexer, Solana confirmation) are slow; the dev server compiles pages on first hit.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: !IS_PROD,
  // Mode B uses ONE account (one licence per Solver): strictly serial. Mode A: one fresh wallet per test, so the tests
  // are independent and can run in parallel (E2E_WORKERS), but the API limits its costly routes (/api/tx, intents,
  // charges, search, faucet) to 20 requests per minute per IP and every browser reaches it from 127.0.0.1 through the
  // Next dev proxy: in parallel the app's own /api/tx/confirm retries get 429. Serial by default.
  workers: IS_PROD ? 1 : Number(process.env.E2E_WORKERS ?? 1),
  retries: 0,
  forbidOnly: true,
  reporter: [["list"], ["html", { outputFolder: "./report/html", open: "never" }], ["json", { outputFile: "./report/results.json" }], ["./src/summary-reporter.ts"]],
  use: {
    baseURL: WEB_URL,
    locale: "en-US",
    // Mode B runs with the owner's live session: traces (cookies, headers) and videos would store it in report/, so
    // they are off there. Mode A traces contain the throwaway anvil dev-wallet key of the test (report/ is gitignored).
    trace: IS_PROD ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: IS_PROD ? "off" : "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  projects: IS_PROD
    ? [
        // Opens a visible browser and waits for the owner to type the e-mail code (only when the saved session expired).
        { name: "prod-login", testMatch: /prod\/login\.setup\.ts/, use: { ...devices["Desktop Chrome"], headless: false } },
        {
          name: "prod",
          testMatch: [/common\/.*\.spec\.ts/, /prod\/.*\.spec\.ts/],
          dependencies: ["prod-login"],
          use: { ...devices["Desktop Chrome"], storageState: PROD_AUTH_FILE },
        },
      ]
    : [{ name: "local", testMatch: [/common\/.*\.spec\.ts/, /local\/.*\.spec\.ts/], use: { ...devices["Desktop Chrome"] } }],
});
