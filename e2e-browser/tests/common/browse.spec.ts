// Scenario 1: home -> search -> Solver page, in Portuguese and English. Pages answer 200, the console stays clean and
// every price shown matches the API (/api/agents) and the Registry on-chain (chainAgent().price).
import { agentDetail, chainAgent, get, getConfig } from "../../src/chain.js";
import { expect, test } from "../../src/fixtures.js";
import { token, usd } from "../../src/money.js";

type Row = { id: string; slug: string; name: string; priceUsdc: number; platform: boolean };

test("scenario 1: home, search and Solver pages (pt and en) show the on-chain prices", async ({ page, diag, evidence }) => {
  const cfg = await getConfig();
  const symbol = cfg.paymentToken.symbol;
  const rows = (await get<Row[]>("/api/agents")).filter((a) => !a.platform && a.priceUsdc > 0);
  expect(rows.length, "paid Solvers in the catalog").toBeGreaterThan(0);

  // Home in both languages.
  for (const locale of ["pt", "en"] as const) {
    const res = await page.goto(`/${locale}`);
    expect(res?.status(), `/${locale} status`).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${locale}`));
    await expect(page.getByRole("search")).toBeVisible();
  }

  // Search (en): describe a need, a result card links to a Solver of the catalog.
  await page.goto("/en");
  await page.locator("#busca").fill("I need accessible React components for my web app");
  await page.getByRole("search").getByRole("button", { name: "Find a solver" }).click();
  const results = page.locator("#sugestoes a[href*='/solvers/']");
  await expect(results.first()).toBeVisible({ timeout: 60_000 });
  const hrefs = await results.evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const slugs = hrefs.map((h) => decodeURIComponent(h.split("/solvers/")[1] ?? ""));
  const known = new Set((await get<Row[]>("/api/agents")).map((a) => a.slug));
  expect(slugs.every((s) => known.has(s)), `search results ${slugs.join(", ")} are catalog Solvers`).toBe(true);
  evidence.checked(`search returned ${slugs.join(", ")} (all in /api/agents)`);

  // Click through to the first result: the page opens.
  await results.first().click();
  // English is the default locale and has no prefix (/solvers/<slug>).
  await expect(page).toHaveURL(/^[^?]*\/solvers\/[^/]+$/);
  expect(new URL(page.url()).pathname.startsWith("/pt/"), "stays in English").toBe(false);
  await expect(page.locator("h1").first()).toBeVisible();

  // Every paid Solver page: the price matches the API and the Registry, in both languages.
  for (const a of rows) {
    const onchain = await chainAgent(a.id);
    const detail = await agentDetail(a.slug);
    expect(onchain.price, `${a.slug}: API priceUsdc ${a.priceUsdc} = on-chain price`).toBe(BigInt(Math.round(a.priceUsdc * 1e6)));
    expect(detail.agent.priceUsdc, `${a.slug}: detail = list price`).toBe(a.priceUsdc);

    const en = await page.goto(`/en/solvers/${encodeURIComponent(a.slug)}`);
    expect(en?.status(), `/en/solvers/${a.slug} status`).toBe(200);
    await expect(page.locator(".price-big")).toHaveText(usd(onchain.price));
    await expect(page.getByText(`Charged as ${token(onchain.price, symbol, "en")}`)).toBeVisible();

    const pt = await page.goto(`/pt/solvers/${encodeURIComponent(a.slug)}`);
    expect(pt?.status(), `/pt/solvers/${a.slug} status`).toBe(200);
    // pt shows reais (server value or FX estimate) plus the exact token amount, which must be the on-chain price.
    await expect(page.locator(".price-big")).toHaveText(/^R\$\s?[\d.]+,\d{2}$/);
    await expect(page.getByText(`Cobrado como ${token(onchain.price, symbol, "pt")}`)).toBeVisible();
    evidence.checked(`${a.slug}: page ${usd(onchain.price)} = /api/agents ${a.priceUsdc} = Registry.getAgent().price ${onchain.price}`);
  }

  expect(diag.errors(), "browser console errors").toEqual([]);
  expect(diag.failedRequests(), "failed requests").toEqual([]);
  evidence.checked("no console errors, no failed requests, every page 200");
});
