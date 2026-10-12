// License transfer with the on-chain royalty (decisions.md D15): owner A buys a license, gets the royalty quote,
// transfers it to B with one sponsored batch `[approve(license, royalty), transferWithRoyalty]` and pays exactly the
// creator share + platform share of the ORIGINAL price (default 5% + 5%); B owns it on-chain and in the API mirror;
// a plain ERC-721 transfer that skips the royalty is refused (RoyaltyNotPaid) before anything is broadcast.
//
//   cd scripts && npx tsx src/e2e-transfer.ts            # API_URL, E2E_SLUG (default frontend-react)
import { encodeFunctionData, type Hex } from "viem";
import { decodeSolversError } from "@solvers/chain";
import { solversLicenseAbi } from "@solvers/contracts-client";
import { royaltySplit } from "@solvers/shared";
import { API_URL, fmt, freshAccount, fund, network, tokenBalance } from "./env.js";
import { agentDetail, buyLicense, chainAgent, eventsOf, expectedRoyalty, getConfig, ownerOf, registryConfig } from "./lib/flows.js";
import { expectFailure } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet, feePayerOf } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";

await run(`e2e-transfer (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const cfg = await getConfig();
  const detail = await agentDetail(SLUG);
  const agent = await chainAgent(detail.agent.id);
  const a = new TestWallet(freshAccount(), "owner A");
  const b = new TestWallet(freshAccount(), "recipient B");

  const lic = (await r.step("A buys a license (sponsored)", async () => {
    const hashes = await fund(a.address, agent.price * 2n);
    r.tx("faucet A", hashes[0]);
    await a.login();
    const p = await buyLicense(a, detail.agent.id, agent.price);
    r.tx("purchase", p.txHash);
    return p;
  }))!;

  // Expected amounts from the on-chain bps with plain bigint arithmetic; the shared helper and the API must agree.
  const reg = await registryConfig();
  const expected = expectedRoyalty(agent.price, agent.royaltyBps, reg.platformRoyaltyBps);
  let quote = { creatorBps: -1, platformBps: -1 };
  await r.step("royalty quote = creator and platform shares of the original price", async () => {
    assertEq(cfg.royalty.platformBps, reg.platformRoyaltyBps, "API platform bps = on-chain Registry config");
    assertEq(royaltySplit(agent.price, agent.royaltyBps, reg.platformRoyaltyBps), expected, "royaltySplit (shared) = script arithmetic");
    const q = await a.get<{ creatorBps: number; platformBps: number; originalPriceUnits: string; creatorAmountUnits: string; platformAmountUnits: string; totalUnits: string }>(
      `/api/me/licenses/${lic.tokenId}/transfer-quote`,
    );
    assertEq(BigInt(q.originalPriceUnits), agent.price, "original price");
    assertEq(q.creatorBps, agent.royaltyBps, "creator bps");
    assertEq(BigInt(q.creatorAmountUnits), expected.creatorAmount, "creator amount");
    assertEq(BigInt(q.platformAmountUnits), expected.platformAmount, "platform amount");
    assertEq(BigInt(q.totalUnits), expected.total, "total");
    const [, cOn, , pOn] = await n.publicClient.readContract({ address: n.deployment.license, abi: solversLicenseAbi, functionName: "quoteRoyalty", args: [lic.tokenId] });
    assertEq([cOn, pOn], [expected.creatorAmount, expected.platformAmount], "on-chain quoteRoyalty");
    quote = q;
    return `${q.creatorBps}/${q.platformBps} bps of ${fmt(agent.price)} = ${fmt(expected.creatorAmount)} + ${fmt(expected.platformAmount)}`;
  });
  if (quote.creatorBps === 500 && quote.platformBps === 500) {
    await r.step("default royalty is exactly 5% + 5% of the original price", async () => {
      assertEq(expected.creatorAmount * 20n, agent.price - (agent.price % 20n), "creator = 5%");
      assertEq(expected.platformAmount, expected.creatorAmount, "platform = creator");
    });
  } else r.skip("exact 5% + 5% split", `this Solver uses ${quote.creatorBps}/${quote.platformBps} bps; the generic split was checked`);

  await r.step("guards: lower accepted royalty -> 409 royalty_changed; same wallet -> 400", async () => {
    await expectFailure(a.post("/api/tx/transfer", { licenseId: lic.tokenId.toString(), to: b.address, maxRoyaltyUnits: (expected.total - 1n).toString() }), 409, "royalty_changed");
    await expectFailure(a.post("/api/tx/transfer", { licenseId: lic.tokenId.toString(), to: a.address, maxRoyaltyUnits: expected.total.toString() }), 400, "same_wallet");
  });

  const creator = agent.creator.toLowerCase() as Hex;
  const before = { a: await tokenBalance(a.address), creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
  const sent = (await r.step("A transfers to B: [approve, transferWithRoyalty] sponsored by the relay", async () => {
    const built = await a.post<{ calls: { to: Hex; data: Hex }[] }>("/api/tx/transfer", { licenseId: lic.tokenId.toString(), to: b.address, maxRoyaltyUnits: expected.total.toString() });
    assertEq(built.calls.length, 2, "calls in the batch");
    const c = await a.sendAndConfirm(built.calls);
    r.tx("transfer with royalty", c.txHash);
    assert(feePayerOf(c.receipt) !== a.lower, "A paid the network fee");
    return c;
  }))!;
  await r.step("exact royalty: A paid creator share + platform share, nothing else", async () => {
    const after = { a: await tokenBalance(a.address), creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
    assertEq(before.a - after.a, expected.total, "A paid");
    assertEq(after.creator - before.creator, expected.creatorAmount, "creator received");
    assertEq(after.treasury - before.treasury, expected.platformAmount, "treasury received");
    const ev = (await eventsOf(sent.receipt)).find((e) => e.eventName === "RoyaltyPaid");
    assert(ev, "no RoyaltyPaid event");
    const args = ev.args as { creatorAmount: bigint; platformAmount: bigint; to: string };
    assertEq([args.creatorAmount, args.platformAmount, args.to.toLowerCase()], [expected.creatorAmount, expected.platformAmount, b.lower], "RoyaltyPaid");
    return `A -${fmt(expected.total)}, creator +${fmt(expected.creatorAmount)}, treasury +${fmt(expected.platformAmount)}`;
  });
  await r.step("B owns the license on-chain and in the API mirror; A no longer lists it", async () => {
    assertEq(await ownerOf(lic.tokenId), b.lower, "ownerOf");
    await b.login();
    const mineB = await b.get<{ id: string }[]>("/api/me/licenses");
    assert(mineB.some((l) => l.id === lic.tokenId.toString()), `B's licenses: ${JSON.stringify(mineB)}`);
    const mineA = await a.get<{ id: string }[]>("/api/me/licenses");
    assert(!mineA.some((l) => l.id === lic.tokenId.toString()), "A still lists the license");
  });
  await r.step("a plain transferFrom that skips the royalty is refused at fill time, nothing broadcast (RoyaltyNotPaid)", async () => {
    const plain = { to: n.deployment.license, data: encodeFunctionData({ abi: solversLicenseAbi, functionName: "transferFrom", args: [b.address, a.address, lic.tokenId] }) };
    let err: Error | undefined;
    try {
      await b.send([plain]);
    } catch (e) {
      err = e as Error;
    }
    assert(err, "the plain transfer went through");
    const name = decodeSolversError(err).name;
    assertEq(name, "RoyaltyNotPaid", "decoded revert");
    assertEq(await ownerOf(lic.tokenId), b.lower, "owner unchanged");
  });
});
