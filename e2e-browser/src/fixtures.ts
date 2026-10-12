// Playwright fixtures of the browser e2e:
//  - `diag`: browser console errors, page errors and failed requests of every page, attached to the test on failure
//    (and readable by the tests that assert a clean console);
//  - `evidence`: transactions (Tempo and Solana) and on-chain checks, recorded as annotations the summary reporter
//    prints with explorer links;
//  - `devWallet`: a fresh dev-wallet key injected into localStorage before any page script runs (mode A only), so each
//    test has its own wallet and tests run in parallel without depending on each other.
import "./env.js";
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { tempoTxLink } from "./chain.js";
import { IS_PROD, WEB_URL } from "./env.js";

/** localStorage key of the web app's dev wallet (apps/web/src/lib/wallet/dev.ts). */
export const DEV_WALLET_STORAGE_KEY = "solvers.devWallet.evm.v1";

export type TxEvidence = { label: string; chain: "tempo" | "solana"; hash: string; link: string | null };

export class Evidence {
  constructor(private readonly info: TestInfo) {}

  /** A Tempo transaction checked by the test (explorer link on Moderato, the bare hash on the local chain). */
  async tempo(label: string, hash: string | null | undefined): Promise<void> {
    if (!hash) return;
    this.push({ label, chain: "tempo", hash, link: await tempoTxLink(hash) });
  }

  /** A Solana transaction checked by the test (devnet explorer). */
  solana(label: string, signature: string | null | undefined): void {
    if (!signature) return;
    this.push({ label, chain: "solana", hash: signature, link: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
  }

  /** What was verified outside the screen (one line per check, shown in the summary). */
  checked(text: string): void {
    this.info.annotations.push({ type: "checked", description: text });
  }

  private push(tx: TxEvidence): void {
    this.info.annotations.push({ type: "tx", description: JSON.stringify(tx) });
  }
}

export type Diag = {
  /** Console errors and uncaught page errors seen so far (all pages of the test). */
  errors(): string[];
  /** Requests that failed at the network level or answered >= 500. */
  failedRequests(): string[];
};

export type DevWallet = { account: PrivateKeyAccount; address: `0x${string}`; lower: string };

type Fixtures = { diag: Diag; evidence: Evidence; devWallet: DevWallet };

/** Console noise that is not an app error (dev-server tooling). */
const IGNORED_CONSOLE = [/Download the React DevTools/i, /\[Fast Refresh\]/i, /\[HMR\]/i];

export const test = base.extend<Fixtures>({
  diag: [
    async ({ context }, use, testInfo) => {
      const errors: string[] = [];
      const failed: string[] = [];
      const watch = (page: Page) => {
        page.on("console", (m) => {
          if (m.type() !== "error") return;
          const text = m.text();
          const from = m.location().url;
          if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
          // A signed-out page asks /api/auth/me once per tab (lib/session.tsx): its 401 is the expected answer.
          if (/status of 401/.test(text) && /\/api\/auth\/me$/.test(from)) return;
          errors.push(`[console] ${page.url()} :: ${text}${from ? ` (${from})` : ""}`);
        });
        page.on("pageerror", (e) => errors.push(`[pageerror] ${page.url()} :: ${e.message}`));
        page.on("requestfailed", (r) => {
          const why = r.failure()?.errorText ?? "";
          // Navigations away from a page abort its pending requests: not a failure of the app.
          if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) failed.push(`${r.method()} ${r.url()} :: ${why}`);
        });
        page.on("response", (r) => {
          if (r.status() >= 500) failed.push(`${r.request().method()} ${r.url()} :: ${r.status()}`);
        });
      };
      context.pages().forEach(watch);
      context.on("page", watch);
      await use({ errors: () => [...errors], failedRequests: () => [...failed] });
      if (testInfo.status !== testInfo.expectedStatus) {
        if (errors.length) await testInfo.attach("browser-console-errors.txt", { body: errors.join("\n"), contentType: "text/plain" });
        if (failed.length) await testInfo.attach("failed-requests.txt", { body: failed.join("\n"), contentType: "text/plain" });
      }
    },
    { auto: true },
  ],

  evidence: async ({}, use, testInfo) => {
    await use(new Evidence(testInfo));
  },

  devWallet: async ({ context }, use) => {
    await use(await injectDevWallet(context));
  },
});

export { expect };

/**
 * A fresh dev-wallet key injected into `context` before any page script runs, only on the web app's origin. The key is
 * never logged (it is in Playwright traces of mode A, which keep the init script; report/ is gitignored).
 */
export async function injectDevWallet(context: BrowserContext, existingKey?: `0x${string}`): Promise<DevWallet> {
  if (IS_PROD) throw new Error("the dev wallet is never used on the public site (mode B logs in with the owner's account)");
  // A given key (the creator of a test Solver, the anvil admin of the QA stack) or a fresh one.
  const key = existingKey ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const origin = new URL(WEB_URL).origin;
  await context.addInitScript(
    ({ storageKey, value, allowed }) => {
      try {
        if (location.origin === allowed && !localStorage.getItem(storageKey)) localStorage.setItem(storageKey, value);
      } catch {
        // about:blank and other origins have no usable storage
      }
    },
    { storageKey: DEV_WALLET_STORAGE_KEY, value: key, allowed: origin },
  );
  return { account, address: account.address, lower: account.address.toLowerCase() };
}

/** The account button of the header once signed in. */
export const accountButton = (page: Page) => page.locator("button.me-pill[aria-controls='account-menu']");

/**
 * Signs in through the header like a person: "Sign in" -> the dev wallet signs the SIWE message (no prompt) -> the
 * account button appears. Mode A only.
 */
export async function signInWithDevWallet(page: Page, path = "/en"): Promise<void> {
  await page.goto(path);
  const signIn = page.getByRole("banner").getByRole("button", { name: /^(Sign in|Entrar)$/ });
  await expect(signIn).toBeVisible({ timeout: 60_000 });
  await signIn.click();
  await expect(accountButton(page)).toBeVisible({ timeout: 60_000 });
}
