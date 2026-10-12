// Scenario 8 (mode A): the install page shows the connector address; an MCP client (as Claude/ChatGPT would) starts
// OAuth from it; the person signs the consent IN THE BROWSER (/connect); the client exchanges the code and its
// list_my_solvers returns the license this wallet holds. A token from nobody gets 401.
import { getConfig } from "../../src/chain.js";
import { ownLicense } from "../../src/data.js";
import { expect, signInWithDevWallet, test } from "../../src/fixtures.js";
import { REDIRECT_URI, exchangeCode, mcpCall, startOAuth } from "../../src/oauth.js";

test("scenario 8: install page -> connector OAuth consent in the browser -> MCP list_my_solvers shows the license", async ({ page, devWallet, evidence }) => {
  const slug = "ui-design";
  const own = await ownLicense(evidence, devWallet.account, slug);
  const cfg = (await getConfig()) as unknown as { connectorUrl: string };

  await signInWithDevWallet(page);
  await page.goto(`/en/install?agent=${slug}`);
  const address = page.getByLabel("Connector address");
  await expect(address).toHaveValue(cfg.connectorUrl);
  const shown = await address.inputValue();
  evidence.checked(`install page shows the connector address ${shown} (= /api/config connectorUrl)`);

  // The MCP client registers and sends the person to the consent page, where they authorize it in the browser.
  let resolveCb: (u: URL) => void = () => {};
  await page.route(`${REDIRECT_URI}**`, async (route) => {
    resolveCb(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "text/plain", body: "callback received" });
  });
  const consent = async (clientName: string) => {
    const oauth = await startOAuth(shown, clientName);
    const callback = new Promise<URL>((r) => (resolveCb = r));
    await page.goto(oauth.authorizeUrl);
    await expect(page).toHaveURL(/\/connect\?/);
    await expect(page.getByText("Connecting as", { exact: false })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: `Authorize ${clientName}` }).click();
    const cb = await callback;
    expect(cb.searchParams.get("state"), "state round-trips").toBe(oauth.state);
    const code = cb.searchParams.get("code");
    expect(code, "authorization code").toBeTruthy();
    return { oauth, code: code! };
  };

  const { oauth, code } = await consent("Claude (browser e2e)");
  const { accessToken } = await exchangeCode(oauth, code);
  await expect(exchangeCode(oauth, code), "the code cannot be replayed").rejects.toThrow(/token exchange: 400/);
  // PKCE is enforced: a second authorization's code with a wrong verifier is refused.
  const second = await consent("ChatGPT (browser e2e)");
  await expect(exchangeCode({ ...second.oauth, verifier: "x".repeat(43) }, second.code), "wrong PKCE verifier").rejects.toThrow(/token exchange: 400/);
  const list = await mcpCall(oauth.mcpUrl, accessToken, "list_my_solvers");
  expect(list.isError, `list_my_solvers: ${list.text.slice(0, 300)}`).toBe(false);
  expect(list.text, "list_my_solvers names the licensed Solver").toContain(own.name);
  expect(list.text, "list_my_solvers carries its id").toContain(own.agentId);
  const act = await mcpCall(oauth.mcpUrl, accessToken, "activate_solver", { agent_id: own.agentId });
  expect(act.text, "activation with the license").toContain("Access: lifetime license.");
  evidence.checked(`OAuth (DCR + PKCE S256: wrong verifier and code replay refused) consented in the browser by ${devWallet.address}; list_my_solvers lists ${own.name} (${own.agentId}); activate_solver: lifetime license`);

  const bogus = await mcpCall(oauth.mcpUrl, "not-a-token", "list_my_solvers");
  expect(bogus.status, "invalid token").toBe(401);
  evidence.checked("an invalid bearer token gets 401 from /mcp");
});
