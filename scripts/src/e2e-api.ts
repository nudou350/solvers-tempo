// The store API through the typed client the web app uses (@solvers/api-client): every answer is parsed with the
// shared zod schemas, so a contract drift between server and client fails here. The session is the httpOnly cookie
// (kept by a tiny cookie jar), exactly like the browser; the wallet sends batches through the platform relay.
//
//   cd scripts && npx tsx src/e2e-api.ts            # API_URL, E2E_SLUG (frontend-react)
import { ApiError, createApi, type WalletLike } from "@solvers/api-client";
import { sendCalls } from "@solvers/chain";
import type { Hex } from "viem";
import { API_URL, fmt, freshAccount, fund, network, sleep } from "./env.js";
import { retryAfterSecs } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";
const COOKIE = "solvers_session";

/** fetch with a one-cookie jar (the session cookie), like a browser on the same site. */
function cookieFetch(jar: { value?: string }): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.value) headers.set("cookie", `${COOKIE}=${jar.value}`);
    let res = await fetch(input, { ...init, headers });
    // The costly routes allow 20 requests/minute per IP: wait for the window like a patient user would.
    for (let i = 0; i < 5 && res.status === 429; i++) {
      const wait = retryAfterSecs(res.headers);
      if (!/rate_limited/.test(await res.clone().text())) break;
      console.log(`        (rate limited; waiting ${wait}s)`);
      await sleep(wait * 1000);
      res = await fetch(input, { ...init, headers });
    }
    for (const c of res.headers.getSetCookie()) {
      const m = new RegExp(`^${COOKIE}=([^;]*)`).exec(c);
      if (m) jar.value = m[1] || undefined;
    }
    return res;
  };
}

async function expectApiError(p: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  try {
    const v = await p;
    throw new Error(`expected ${status}${code ? ` ${code}` : ""}, got success: ${JSON.stringify(v).slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status !== status || (code && e.code !== code)) throw new Error(`expected ${status} ${code ?? ""}, got ${e.status} ${e.code}: ${e.message}`);
    return e;
  }
}

await run(`e2e-api (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const jar: { value?: string } = {};
  const api = createApi({ baseUrl: API_URL, fetch: cookieFetch(jar) });
  const account = freshAccount();
  const tw = new TestWallet(account, "buyer");
  const wallet: WalletLike = {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    async sendCalls(calls) {
      const client = await tw.relayClient(jar.value);
      return sendCalls(client as never, calls, { feePayer: true });
    },
  };

  const cfg = (await r.step("getConfig parses (PublicConfig)", async (note) => {
    const c = await api.getConfig();
    assertEq(c.chainId, n.chainId, "chain id");
    note(`fee ${c.feeBps} bps, royalty ${c.royalty.creatorBps}/${c.royalty.platformBps}, min ${fmt(BigInt(c.minPriceUnits))}`);
    return c;
  }))!;
  const detail = (await r.step("catalog: agents, categories, detail (en + pt), reviews, creators, search", async (note) => {
    const agents = await api.getAgents();
    assert(agents.some((a) => a.slug === SLUG), `${SLUG} not in /api/agents`);
    await api.getCategories();
    const en = await api.getAgent(SLUG, "en");
    const pt = await api.getAgent(SLUG, "pt");
    assertEq(pt.agent.id, en.agent.id, "same Solver in both languages");
    await api.getReviews(SLUG);
    const creators = await api.getCreators();
    assert(creators.some((c) => c.id === en.agent.creatorId), "creator not listed");
    await api.getCreator(en.agent.creatorId);
    const found = await api.search("accessible React login form with tests");
    assert(found.some((a) => a.slug === SLUG), "search did not find the Solver");
    note(`${agents.length} Solvers listed`);
    return en;
  }))!;

  await r.step("SIWE login (api.login) opens the cookie session", async () => {
    const n0 = await fetch(`${API_URL}/api/auth/nonce?address=${account.address}`).then((x) => x.json() as Promise<{ domain: string; uri: string }>);
    const res = await api.login(wallet, { domain: n0.domain, uri: n0.uri });
    assertEq(res.wallet.toLowerCase(), account.address.toLowerCase(), "wallet");
    assert(jar.value, "no session cookie");
    assertEq((await api.me()).wallet.toLowerCase(), account.address.toLowerCase(), "me");
  });
  await r.step("faucet (testnet): /api/faucet, else the network faucet when the API is in its cooldown", async (note) => {
    try {
      const f = (await api.faucet()) as { txHash: Hex | null; txHashes?: Hex[] };
      r.tx("api faucet", f.txHash);
      // The faucet answers once the funding txs are broadcast; wait for them before reading the balance.
      for (const h of f.txHashes ?? (f.txHash ? [f.txHash] : [])) await n.publicClient.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
      note("funded by /api/faucet");
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "faucet_cooldown") throw e;
      r.tx("network faucet", (await fund(account.address, 50_000_000n))[0]);
      note("API faucet in cooldown for this IP; funded by tempo_fundAddress");
    }
    const bal = await api.getBalance();
    assert(BigInt(bal.units) > 0n, `balance ${bal.units}`);
  });
  await r.step("credits are refused for a Solver without pay-per-use (400 pay_per_use_disabled)", async () => {
    await expectApiError(api.createPurchaseIntent({ kind: "credits", agentId: detail.agent.id, amount: 10 }), 400, "pay_per_use_disabled");
  });
  const bought = (await r.step("buildPurchase -> wallet sends through the relay -> confirm (sendAndConfirm)", async (note) => {
    const built = await api.buildPurchase(detail.agent.id);
    assertEq(built.feePayer, true, "feePayer");
    const c = await api.sendAndConfirm(wallet, built);
    assertEq(c.status, "confirmed", "confirm");
    r.tx("purchase", c.txHash);
    const ev = (c as { events?: { name: string; args: { tokenId?: string } }[] }).events?.find((x) => x.name === "LicensePurchased");
    assert(ev?.args.tokenId, "no LicensePurchased in the confirm answer");
    note(`license #${ev.args.tokenId}`);
    return { tokenId: ev.args.tokenId, chargeId: built.chargeId };
  }))!;
  await r.step("account views: licenses, charge, access, license metadata, quote, payouts, reputation, profile", async () => {
    const lic = await api.getMyLicenses();
    assert(lic.some((l) => l.id === bought.tokenId), "license missing in getMyLicenses");
    assertEq((await api.getCharge(bought.chargeId)).status, "fulfilled", "charge status");
    const access = await api.getMyAccess(SLUG);
    assert(JSON.stringify(access).includes(bought.tokenId), `access: ${JSON.stringify(access)}`);
    await api.getLicenseMetadata(bought.tokenId);
    const q = await api.getTransferQuote(bought.tokenId);
    assertEq(BigInt(q.totalUnits), BigInt(q.creatorAmountUnits) + BigInt(q.platformAmountUnits), "quote total");
    const payouts = await api.getMyPayouts();
    assertEq(payouts.totalUnits, "0", "deferred payouts");
    await expectApiError(api.buildClaim(), 409, "nothing_to_claim");
    await api.getReputation();
    await api.getProfile();
    await api.getMyTrials();
    await api.getMyGuarantee();
    void cfg;
  });
  await r.step("buying the same Solver again is refused (409 already_owned)", async () => {
    await expectApiError(api.buildPurchase(detail.agent.id), 409, "already_owned");
  });
  await r.step("logout ends the session (me -> 401)", async () => {
    await api.logout();
    await expectApiError(api.me(), 401);
  });
});
