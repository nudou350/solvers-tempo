// License cap end to end (Registry `setSupplyCap`, plan §4.1): a fresh creator registers a test Solver with cap 1 in
// one sponsored batch, the admin approves it, buyer A takes the only license, buyer B is stopped by the contract
// (SoldOut) at fill time without moving any token, the cap can only go up (same or lower value refused), the creator
// raises it to 2 and B buys. The test Solver is suspended at the end so it does not stay sellable.
//
// Everything goes through the platform relay (`POST /api/relay`) with SIWE sessions, exactly like the web app. The
// admin key comes from SERVER_ENV_FILE (ADMIN_PRIVATE_KEY) or ADMIN_KEY.
//
//   cd scripts && npx tsx src/e2e-supply.ts
import { approveAgentCalls, decodeSolversError, publishAgentCalls, purchaseLicenseCalls, setSupplyCapCalls, suspendAgentCalls, type Call } from "@solvers/chain";
import { solversRegistryAbi } from "@solvers/contracts-client";
import { agentIdToBytes32 } from "@solvers/shared";
import { keccak256, toHex, type Hex } from "viem";
import { API_URL, fmt, freshAccount, fund, network, serverAccount, tokenBalance } from "./env.js";
import { chainAgent, randomHex32 } from "./lib/flows.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

/** Sends and expects a refusal decoded as one of `names`; returns the name. */
async function expectRevert(w: TestWallet, calls: Call[], names: string[]): Promise<string> {
  try {
    const { hash } = await w.send(calls);
    throw new Error(`expected ${names.join("|")}, but ${hash} was mined`);
  } catch (e) {
    if ((e as Error).message.startsWith("expected ")) throw e;
    const name = decodeSolversError(e).name;
    assert(names.includes(name), `expected ${names.join("|")}, got ${name}: ${(e as Error).message.slice(0, 200)}`);
    return name;
  }
}

await run(`e2e-supply (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const d = n.deployment;
  const id16 = toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
  const agentId = agentIdToBytes32(id16);
  const creator = await new TestWallet(freshAccount(), "creator").login();
  const admin = await new TestWallet(serverAccount("ADMIN_PRIVATE_KEY", process.env.ADMIN_KEY), "admin").login();
  const minStake = await n.publicClient.readContract({ address: d.registry, abi: solversRegistryAbi, functionName: "minStake" });
  const price = await n.publicClient.readContract({ address: d.registry, abi: solversRegistryAbi, functionName: "minPrice" });

  await r.step("creator registers a test Solver with license cap 1 (one sponsored batch)", async (note) => {
    if (minStake > 0n) r.tx("faucet creator", (await fund(creator.address, minStake))[0]);
    const calls = publishAgentCalls(d, {
      registration: {
        agentId,
        metadataUri: `https://solvers-tempo.wondervelop.com/api/agents/${id16}/metadata.json`,
        version: "1.0.0",
        versionHash: keccak256(toHex(`e2e-supply ${id16}`)),
        price,
        pricePerUse: 0n,
        royaltyBps: 500,
      },
      minStake,
      maxSupply: 1,
    });
    const { hash } = await creator.send(calls);
    r.tx("register + cap 1", hash);
    const a = await chainAgent(id16);
    assertEq([a.status, a.maxSupply, a.creator.toLowerCase()], [0, 1, creator.lower], "pending agent with cap 1");
    note(`agent ${id16}, price ${fmt(price)}`);
  });
  await r.step("admin approves it (Active)", async () => {
    const { hash } = await admin.send(approveAgentCalls(d, agentId));
    r.tx("approveAgent", hash);
    assertEq((await chainAgent(id16)).status, 1, "status");
  });

  // From here on the test Solver is Active: it is suspended in `finally`, also when a check above stops the run.
  try {
    const a = await new TestWallet(freshAccount(), "buyer A").login();
    const b = await new TestWallet(freshAccount(), "buyer B").login();
    r.tx("faucet A", (await fund(a.address, price))[0]);
    r.tx("faucet B", (await fund(b.address, price))[0]);

    await r.step("buyer A takes the only license", async () => {
      const { hash } = await a.send(purchaseLicenseCalls(d, { agentId, price, purchaseId: randomHex32() }));
      r.tx("purchase A", hash);
      assertEq((await chainAgent(id16)).totalSales, 1, "total sales");
    });
    await r.step("buyer B is refused with SoldOut and no token moves", async (note) => {
      const before = await tokenBalance(b.address);
      const name = await expectRevert(b, purchaseLicenseCalls(d, { agentId, price, purchaseId: randomHex32() }), ["SoldOut"]);
      assertEq(await tokenBalance(b.address), before, "B balance");
      assertEq((await chainAgent(id16)).totalSales, 1, "total sales");
      note(name);
    });
    await r.step("the cap only goes up: setting it to the same value is refused", async (note) => {
      note(await expectRevert(creator, setSupplyCapCalls(d, { agentId, max: 1 }), ["SupplyCapCannotDecrease", "SupplyCapTooLow"]));
    });
    await r.step("creator raises the cap to 2, then B buys", async () => {
      const raise = await creator.send(setSupplyCapCalls(d, { agentId, max: 2 }));
      r.tx("setSupplyCap 2", raise.hash);
      const buy = await b.send(purchaseLicenseCalls(d, { agentId, price, purchaseId: randomHex32() }));
      r.tx("purchase B", buy.hash);
      const ag = await chainAgent(id16);
      assertEq([ag.maxSupply, ag.totalSales], [2, 2], "cap and sales");
    });
    await r.step("lowering the cap below the sales is refused", async (note) => {
      note(await expectRevert(creator, setSupplyCapCalls(d, { agentId, max: 1 }), ["SupplyCapCannotDecrease", "SupplyCapTooLow"]));
    });
  } finally {
    await r.step(
      "cleanup: admin suspends the test Solver",
      async () => {
        const { hash } = await admin.send(suspendAgentCalls(d, agentId));
        r.tx("suspendAgent", hash);
        assertEq((await chainAgent(id16)).status, 2, "status (2 = Suspended)");
      },
      { critical: false },
    );
  }
});
