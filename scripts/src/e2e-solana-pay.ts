// Solana Pay end to end: a buyer signed in with a Tempo wallet opens a Solana Pay charge for ONE license, a devnet
// payer pays the transfer request exactly as a wallet would (transferChecked + reference key + memo), and the server
// finds the payment by its reference, then the PLATFORM key fulfils it on Tempo from its float (`purchaseLicenseFor`),
// like Pix. The buyer's Tempo wallet never holds stablecoin.
//
// Needs a server with SOLANA_PAY_ENABLED on Solana devnet (refused otherwise) and a funded devnet payer
// (SOLANA_PAYER_KEYPAIR, default scripts/.keys/solana-devnet-payer.json; see `npm run solana:balances`).
// Spends the price of the cheapest purchasable license (real devnet test USDC, faucet-limited).
//
//   cd scripts && npm run e2e:solana-pay
//   API_URL, E2E_SLUG (default: the cheapest purchasable paid Solver), SOLANA_RPC_URL (devnet),
//   E2E_SOLANA_UNDERPAY=1 also pays (price - 0.01) to a second charge and checks it stays pending (spends that too).
import { solversLicenseAbi } from "@solvers/contracts-client";
import { SolanaPayCharge, purchaseIdFor } from "@solvers/shared";
import { address, getBase64Encoder } from "@solana/kit";
import type { Hex } from "viem";
import { API_URL, freshAccount, network, serverAccount, sleep, tokenBalance } from "./env.js";
import { agentDetail, chainAgent, eventsOf, getConfig, ownerOf, waitFor, type AgentRow } from "./lib/flows.js";
import { expectFailure, get } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import {
  FAUCETS,
  SOLANA_RPC_URL,
  assertDevnet,
  fromUnits,
  loadPayer,
  mintDecimals,
  parseSolanaPayUrl,
  payTransferRequest,
  solBalance,
  solanaExplorerTx,
  splBalance,
  toUnits,
  transactionAccountKeys,
} from "./lib/solana.js";
import { TestWallet } from "./lib/wallet.js";

const UNDERPAY = process.env.E2E_SOLANA_UNDERPAY === "1";
const PAY_TIMEOUT_MS = 120_000;
/** SOL the payer needs: fees + rent of the recipient's token account when it does not exist yet (~0.00204 SOL). */
const MIN_SOL_LAMPORTS = 10_000_000n;
const TERMINAL_BAD = new Set(["refunding", "refunded", "expired", "failed"]);
const TEST_SLUG = /^(e2e|qa)-/;

const chargePath = (id: string) => `/api/solana-pay/charges/${encodeURIComponent(id)}`;

/** E2E_SLUG, else the cheapest listed paid Solver that can be bought now (active, price >= min price, not sold out). */
async function pickSolver(minPriceUnits: bigint): Promise<{ id: string; slug: string; price: bigint }> {
  if (process.env.E2E_SLUG) {
    const d = await agentDetail(process.env.E2E_SLUG);
    return { id: d.agent.id, slug: d.agent.slug, price: (await chainAgent(d.agent.id)).price };
  }
  const rows = (await get<AgentRow[]>("/api/agents")).filter((a) => !a.platform && !TEST_SLUG.test(a.slug) && a.priceUsdc > 0);
  rows.sort((a, b) => a.priceUsdc - b.priceUsdc);
  for (const a of rows) {
    const c = await chainAgent(a.id).catch(() => null);
    if (!c || c.status !== 1 || c.price < minPriceUnits || (c.maxSupply !== 0 && c.totalSales >= c.maxSupply)) continue;
    return { id: a.id, slug: a.slug, price: c.price };
  }
  throw new Error("no purchasable paid Solver in the catalog (set E2E_SLUG)");
}

await run(`e2e-solana-pay (${API_URL}, Solana ${SOLANA_RPC_URL})`, async (r) => {
  const n = await network();
  // Tempo hashes are 0x…; anything else is a Solana signature.
  r.setExplorer((h) => (h.startsWith("0x") ? n.explorer(h) : solanaExplorerTx(h)));

  const cfg = (await r.step("Solana Pay is enabled on devnet (GET /api/config)", async (note) => {
    const c = await getConfig();
    assert(c.solanaPay, "the API has no solanaPay in /api/config (server without the Solana Pay checkout)");
    assert(c.solanaPay.enabled, `Solana Pay is disabled on ${API_URL}: start the server with SOLANA_PAY_ENABLED=1 and SOLANA_PAY_KEYPAIR (config: ${JSON.stringify(c.solanaPay)})`);
    assertEq(c.solanaPay.cluster, "devnet", "cluster (the scripts never pay on mainnet-beta)");
    assert(c.solanaPay.recipient, "enabled without a recipient");
    await assertDevnet();
    const decimals = await mintDecimals(address(c.solanaPay.mint));
    assertEq(decimals, n.decimals, "SPL mint decimals = Tempo token decimals");
    note(`recipient ${c.solanaPay.recipient}, ${c.solanaPay.tokenSymbol} ${c.solanaPay.mint}`);
    return { ...c.solanaPay, recipient: c.solanaPay.recipient, minPriceUnits: BigInt(c.minPriceUnits) };
  }))!;
  const mint = address(cfg.mint);
  const recipient = address(cfg.recipient);

  const solver = (await r.step("pick the Solver (cheapest purchasable paid license unless E2E_SLUG)", async (note) => {
    const s = await pickSolver(cfg.minPriceUnits);
    assert(s.price >= cfg.minPriceUnits, `price ${fromUnits(s.price, 6)} below the min price ${fromUnits(cfg.minPriceUnits, 6)}`);
    note(`${s.slug}: ${fromUnits(s.price, 6)} ${cfg.tokenSymbol}`);
    return s;
  }))!;
  const agentBefore = await chainAgent(solver.id);

  const payer = await loadPayer();
  await r.step("payer has enough USDC and SOL on devnet", async (note) => {
    const need = solver.price + (UNDERPAY ? solver.price - 10_000n : 0n);
    const [usdc, sol] = await Promise.all([splBalance(payer.address, mint), solBalance(payer.address)]);
    const lack: string[] = [];
    if (usdc < need) lack.push(`${cfg.tokenSymbol} ${fromUnits(usdc, 6)} < ${fromUnits(need, 6)} (${FAUCETS.usdc})`);
    if (sol < MIN_SOL_LAMPORTS) lack.push(`SOL ${fromUnits(sol, 9)} < ${fromUnits(MIN_SOL_LAMPORTS, 9)} (${FAUCETS.sol})`);
    assert(lack.length === 0, `fund the payer ${payer.address}: ${lack.join("; ")}`);
    note(`${payer.address}: ${fromUnits(usdc, 6)} ${cfg.tokenSymbol}, ${fromUnits(sol, 9)} SOL`);
  });

  const buyer = await new TestWallet(freshAccount(), "buyer").login();
  const platform = serverAccount("PLATFORM_PRIVATE_KEY").address.toLowerCase();

  const charge = (await r.step("charge for ONE license (shape = shared SolanaPayCharge, priced on-chain)", async (note) => {
    const raw = await buyer.post<unknown>("/api/solana-pay/charges", { kind: "license", agentId: solver.id });
    const parsed = SolanaPayCharge.safeParse(raw);
    assert(parsed.success, `response does not match SolanaPayCharge: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 600)}`);
    const c = parsed.data;
    assertEq([c.status, c.kind, c.agentId, c.cluster], ["pending_payment", "license", solver.id, "devnet"], "charge");
    assert(c.id.startsWith("sol"), `charge id ${c.id} without the sol prefix`);
    assertEq(BigInt(c.amountUnits), agentBefore.price, "amount = on-chain price");
    assertEq(c.amount, fromUnits(BigInt(c.amountUnits), 6), "amount (decimal) = amountUnits");
    assertEq(c.purchaseId, purchaseIdFor(c.id), "purchase id = keccak(solvers:v1: + chargeId)");
    assertEq([c.recipient, c.mint, c.tokenSymbol], [cfg.recipient, cfg.mint, cfg.tokenSymbol], "recipient/mint/symbol = /api/config");
    assertEq([c.solanaSignature, c.txHash, c.refundSignature], [null, null, null], "nothing paid yet");
    assert(Date.parse(c.expiresAt) > Date.now(), `expiresAt ${c.expiresAt} already past`);
    const png = getBase64Encoder().encode(c.qrCodeBase64);
    assertEq([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "qrCodeBase64 is a PNG (no data: prefix)");
    note(`${c.id}: ${c.amount} ${c.tokenSymbol}, reference ${c.reference}`);
    return c;
  }))!;

  await r.step("the Solana Pay URL encodes recipient, spl-token, amount, reference and memo of the charge", async () => {
    const u = parseSolanaPayUrl(charge.url);
    assertEq([u.recipient, u.splToken, u.references], [charge.recipient, charge.mint, [charge.reference]], "recipient / spl-token / reference");
    assert(u.amount !== null, "no amount in the URL");
    assertEq(toUnits(u.amount, 6), BigInt(charge.amountUnits), "URL amount");
    assertEq(u.memo, charge.id, "memo = charge id");
    assert(u.label, "no label");
  });

  await r.step("another wallet cannot read the charge (404)", async () => {
    const stranger = await new TestWallet(freshAccount(), "stranger").login();
    await expectFailure(stranger.get(chargePath(charge.id)), 404);
  });

  await r.step("GET before payment: still pending, nothing sent", async () => {
    const c = SolanaPayCharge.parse(await buyer.get(chargePath(charge.id)));
    assertEq([c.status, c.solanaSignature, c.txHash], ["pending_payment", null, null], "charge");
  });

  const recipientBefore = await splBalance(recipient, mint);
  const paid = (await r.step("payer pays the transfer request on Solana devnet (transferChecked + reference + memo)", async (note) => {
    const p = await payTransferRequest(payer, charge.url);
    r.tx("Solana Pay payment (devnet)", p.signature);
    const keys = await transactionAccountKeys(p.signature);
    assert(keys.includes(charge.reference), "the reference is not among the transaction's account keys");
    note(`${fromUnits(p.amountUnits, 6)} ${cfg.tokenSymbol}${p.createdRecipientAta ? ", created the recipient's token account" : ""}`);
    return p;
  }))!;
  await r.step(
    "the recipient's USDC balance grew by the charge amount",
    async () => {
      const after = await splBalance(recipient, mint);
      assertEq(after - recipientBefore, BigInt(charge.amountUnits), "recipient balance delta");
    },
    { critical: false },
  );

  const fulfilled = (await r.step(`server finds the payment and fulfils on Tempo (GET polled, up to ${PAY_TIMEOUT_MS / 1000} s)`, async (note) => {
    const t0 = Date.now();
    // Own loop (not waitFor, which retries on errors): a refunded/expired/failed charge stops the wait at once.
    let c: SolanaPayCharge | undefined;
    let last = "";
    while (Date.now() - t0 < PAY_TIMEOUT_MS) {
      const x = SolanaPayCharge.parse(await buyer.get(chargePath(charge.id)));
      if (TERMINAL_BAD.has(x.status)) throw new Error(`charge went ${x.status}: ${JSON.stringify(x).slice(0, 500)}`);
      if (x.status === "fulfilled") {
        c = x;
        break;
      }
      last = x.status;
      await sleep(2500);
    }
    assert(c, `charge not fulfilled after ${PAY_TIMEOUT_MS / 1000} s (last status ${last})`);
    assertEq(c.solanaSignature, paid.signature, "solanaSignature = our payment");
    assert(c.solanaExplorerUrl?.includes(paid.signature) && c.solanaExplorerUrl.includes("cluster=devnet"), `solanaExplorerUrl ${c.solanaExplorerUrl}`);
    assert(c.txHash, "no Tempo fulfilment tx");
    assertEq(c.refundSignature, null, "refundSignature");
    r.tx("Tempo fulfilment (purchaseLicenseFor)", c.txHash);
    note(`fulfilled after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return c;
  }))!;

  const tokenId = (await r.step("the license is minted to the buyer on Tempo, paid by the PLATFORM float", async () => {
    const receipt = await n.publicClient.getTransactionReceipt({ hash: fulfilled.txHash! as Hex });
    assertEq(receipt.status, "success", "receipt status");
    assertEq(receipt.from.toLowerCase(), platform, "sender = PLATFORM key");
    const ev = (await eventsOf(receipt)).find((e) => e.eventName === "LicensePurchased");
    assert(ev, "no LicensePurchased");
    const a = ev.args as { buyer: string; payer: string; tokenId: bigint; purchaseId: Hex; price: bigint };
    assertEq([a.buyer.toLowerCase(), a.payer.toLowerCase(), a.purchaseId, a.price], [buyer.lower, platform, charge.purchaseId, agentBefore.price], "LicensePurchased");
    assertEq(await ownerOf(a.tokenId), buyer.lower, "ownerOf");
    assertEq(await tokenBalance(buyer.address), 0n, "buyer stablecoin balance on Tempo (never needed)");
    return a.tokenId;
  }))!;

  await r.step("the buyer sees the license in the API (polled, up to 60 s)", async (note) => {
    const t0 = Date.now();
    await waitFor("the license in /api/me/licenses", async () => (await buyer.get<{ id: string }[]>("/api/me/licenses")).some((l) => l.id === tokenId.toString()), 60_000, 1000);
    note(`#${tokenId} listed after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  });

  await r.step("GETs after fulfilment change nothing (idempotent: one sale, one license)", async () => {
    const again = await Promise.all([buyer.get(chargePath(charge.id)), buyer.get(chargePath(charge.id))]);
    for (const raw of again) {
      const c = SolanaPayCharge.parse(raw);
      assertEq([c.status, c.solanaSignature, c.txHash?.toLowerCase(), c.refundSignature], ["fulfilled", paid.signature, fulfilled.txHash!.toLowerCase(), null], "charge after re-reads");
    }
    const held = await n.publicClient.readContract({ address: n.deployment.license, abi: solversLicenseAbi, functionName: "balanceOf", args: [buyer.address] });
    assertEq(held, 1n, "licenses held by the buyer");
    const agentAfter = await chainAgent(solver.id);
    assertEq(agentAfter.totalSales - agentBefore.totalSales, 1, "sales counted for the charge");
  });

  await r.step("at most 3 open Solana Pay charges per wallet (429 solana_pending_limit)", async () => {
    const w = await new TestWallet(freshAccount(), "pending-limit").login();
    for (let i = 0; i < 3; i++) await w.post("/api/solana-pay/charges", { kind: "license", agentId: solver.id });
    await expectFailure(w.post("/api/solana-pay/charges", { kind: "license", agentId: solver.id }), 429, "solana_pending_limit");
  });

  if (UNDERPAY) {
    await r.step("an underpaid transfer (amount - 0.01) to a new charge's reference keeps it pending", async (note) => {
      const c = SolanaPayCharge.parse(await buyer.post("/api/solana-pay/charges", { kind: "license", agentId: solver.id }));
      const p = await payTransferRequest(payer, c.url, { overrideUnits: BigInt(c.amountUnits) - 10_000n });
      r.tx("underpaid Solana Pay transfer (devnet)", p.signature);
      // The 30 s reconcile job and the GET both re-check; give them a full cycle and a half.
      const until = Date.now() + 45_000;
      while (Date.now() < until) {
        const x = SolanaPayCharge.parse(await buyer.get(chargePath(c.id)));
        assertEq([x.status, x.solanaSignature, x.txHash], ["pending_payment", null, null], "underpaid charge");
        await sleep(5000);
      }
      note(`${c.id} still pending 45 s after paying ${fromUnits(p.amountUnits, 6)} of ${c.amount}`);
    });
  } else {
    console.log("  INFO  underpaid-transfer check not run (spends test USDC; E2E_SOLANA_UNDERPAY=1 runs it)");
  }
});
