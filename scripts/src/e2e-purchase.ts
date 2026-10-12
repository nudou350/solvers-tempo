// Direct-wallet purchase end to end (plan §5 `direct-wallet`): a fresh buyer signs in with SIWE, asks the API for a
// purchase intent (ledger row + `[approve, purchaseLicense]` calls), sends the batch through the platform relay
// (`POST /api/relay`, the relay pays the network fee) and confirms it. Checks exact token movements (buyer pays exactly
// the price, creator gets price - fee, treasury gets the fee), the NFT owner, the API mirror and the ledger.
//
//   cd scripts && npx tsx src/e2e-purchase.ts            # API_URL (default http://127.0.0.1:3018), E2E_SLUG (frontend-react)
import { feeSplit } from "@solvers/shared";
import { solversRegistryAbi } from "@solvers/contracts-client";
import { network, fmt, fund, freshAccount, serverAccount, tokenBalance, API_URL } from "./env.js";
import { agentDetail, buyLicense, chainAgent, getConfig, licenseOf, ownerOf } from "./lib/flows.js";
import { expectFailure, get } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet, feePayerOf } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";

await run(`e2e-purchase (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const cfg = await r.step("API config matches the local deployment", async () => {
    const c = await getConfig();
    assertEq(c.chainId, n.chainId, "chain id");
    assert(c.feeBps !== null, "fee bps unreadable");
    return c;
  });
  const detail = (await r.step(`Solver ${SLUG} is listed and active on-chain`, async () => {
    const d = await agentDetail(SLUG);
    const a = await chainAgent(d.agent.id);
    assertEq(a.status, 1, "on-chain status (1 = Active)");
    return d;
  }))!;
  const agent = await chainAgent(detail.agent.id);
  const price = agent.price;
  const buyer = new TestWallet(freshAccount(), "buyer");

  await r.step("fresh buyer funded with test stablecoins (faucet)", async () => {
    const hashes = await fund(buyer.address, price);
    for (const h of hashes) r.tx("faucet", h);
    return `${fmt(await tokenBalance(buyer.address))} on ${buyer.address}`;
  });
  await r.step("relay refuses requests without a session (401)", async () => {
    const res = await fetch(`${API_URL}/api/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    assertEq(res.status, 401, "status");
  });
  await r.step("SIWE sign-in", async () => {
    await buyer.login();
    const me = await buyer.get<{ wallet: string }>("/api/auth/me");
    assertEq(me.wallet.toLowerCase(), buyer.lower, "session wallet");
  });
  await r.step("intent with a stale price is refused (409 price_changed)", async () => {
    await expectFailure(buyer.post("/api/purchases/intent", { kind: "license", agentId: detail.agent.id, expectedPriceUnits: (price + 1n).toString() }), 409, "price_changed");
  });

  const creator = agent.creator.toLowerCase() as `0x${string}`;
  const treasury = n.deployment.treasury;
  const before = { buyer: await tokenBalance(buyer.address), creator: await tokenBalance(creator), treasury: await tokenBalance(treasury) };
  const purchase = (await r.step("sponsored purchase: intent -> relay -> confirm", async () => {
    const p = await buyLicense(buyer, detail.agent.id, price);
    r.tx("purchase", p.txHash);
    return p;
  }))!;

  await r.step("the relay paid the fee (receipt feePayer), not the buyer", async () => {
    const payer = feePayerOf(purchase.receipt);
    assert(payer && payer !== buyer.lower, `fee payer ${payer}`);
    let relay: string | undefined;
    try {
      relay = serverAccount("RELAY_PRIVATE_KEY").address.toLowerCase();
    } catch {
      relay = undefined;
    }
    if (relay) assertEq(payer, relay, "fee payer = RELAY key");
    return `feePayer ${payer}`;
  });
  await r.step("exact token movements (buyer = price, creator = price - fee, treasury = fee)", async () => {
    const { fee, rest } = feeSplit(price, cfg!.feeBps!);
    const after = { buyer: await tokenBalance(buyer.address), creator: await tokenBalance(creator), treasury: await tokenBalance(treasury) };
    assertEq(before.buyer - after.buyer, price, "buyer paid");
    assertEq(after.creator - before.creator, rest, "creator received");
    assertEq(after.treasury - before.treasury, fee, "treasury received");
    return `price ${fmt(price)}, fee ${fmt(fee)}, creator ${fmt(rest)}`;
  });
  await r.step("license NFT owned by the buyer, original price recorded", async () => {
    assertEq(await ownerOf(purchase.tokenId), buyer.lower, "ownerOf");
    const lic = await licenseOf(purchase.tokenId);
    assertEq(lic.originalPrice, price, "originalPrice");
    return `tokenId ${purchase.tokenId}`;
  });
  await r.step("the API mirror shows the license right after confirm", async () => {
    const mine = await buyer.get<{ id: string; agentId: string }[]>("/api/me/licenses");
    assert(mine.some((l) => l.id === purchase.tokenId.toString() && l.agentId === detail.agent.id), `not in /api/me/licenses: ${JSON.stringify(mine)}`);
  });
  await r.step("ledger: the charge is fulfilled with the purchase tx", async () => {
    const c = await buyer.get<{ status: string; txHash: string | null; provider: string }>(`/api/purchases/${purchase.chargeId}`);
    assertEq(c.provider, "direct-wallet", "provider");
    assertEq(c.status, "fulfilled", "status");
    assertEq(c.txHash?.toLowerCase(), purchase.txHash.toLowerCase(), "tx hash");
  });
  await r.step("on-chain purchase id is bound to this purchase (purchaseRef)", async () => {
    const ref = await n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "purchaseRef", args: [buyer.address, purchase.purchaseId] });
    assert(BigInt(ref) !== 0n, "purchaseRef is empty");
  });
  await r.step("license metadata (tokenURI JSON)", async () => {
    const m = await get<{ name: string; attributes: unknown[] }>(`/api/license/${purchase.tokenId}`);
    assert(m.name && m.name.length > 0, `metadata: ${JSON.stringify(m)}`);
    return m.name;
  });
});
