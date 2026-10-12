// An autonomous agent BUYS a Solver over HTTP 402 with the Machine Payments Protocol (decisions.md D4: `mppx` client,
// `tempo` method, `charge` intent, pull mode: the agent signs, the server co-signs the fee as RELAY and broadcasts),
// then USES it through the MCP connector with its own key (two-call agent login). From a brand-new wallet that only
// holds the stablecoin:
//   quote -> 402 challenge -> forged credential refused -> paid purchase (200, license in the agent's wallet, exactly the
//   price debited, no fee) -> order status -> agent login -> list/activate (lifetime license) / next_step / run_tool /
//   memory -> second purchase refused (409 already_owned) with nothing charged.
//
// Server: AGENT_PAY_ENABLED=true and MPP_SECRET_KEY set.
//   cd scripts && npx tsx src/e2e-agent-pay.ts       # API_URL, E2E_SLUG (frontend-react)
import { Mppx, tempo } from "mppx/client";
import type { Hex } from "viem";
import { API_URL, fmt, freshAccount, fund, network, serverAccount, tokenBalance } from "./env.js";
import { call, connectAgent, initialize, sessionIdOf } from "./lib/agent-client.js";
import { chainAgent, getConfig, ownerOf, registryConfig, waitFor } from "./lib/flows.js";
import { get } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import { feePayerOf } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";

type Quote = { agentId: string; priceUnits: string | null; available: boolean; reason?: string; endpoint: string; chainId: number; token: string; protocol: string };
type Order = { orderId: string; status: string; owner: string | null; licenseId: string | null; txHash: Hex | null; settlementTx: Hex | null; priceUnits: string };

await run(`e2e-agent-pay (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  await r.step("agent payments are enabled (MPP)", async () => {
    const c = await getConfig();
    assert(c.agentPay.enabled, `agentPay: ${JSON.stringify(c.agentPay)} (start the API with AGENT_PAY_ENABLED=true and MPP_SECRET_KEY)`);
  });
  const quote = (await r.step(`quote for ${SLUG}`, async (note) => {
    const q = await get<Quote>(`/api/agent-pay/solvers/${SLUG}`);
    assert(q.available && q.priceUnits, `not available: ${JSON.stringify(q)}`);
    assertEq([q.protocol, q.chainId, q.token.toLowerCase()], ["mpp", n.chainId, n.deployment.token.toLowerCase()], "quote");
    note(`${fmt(BigInt(q.priceUnits))} for ${q.agentId}`);
    return q;
  }))!;
  const price = BigInt(quote.priceUnits!);
  const onchain = await chainAgent(quote.agentId);
  const reg = await registryConfig();
  await r.step("the quoted price is the on-chain price", async () => {
    assertEq(price, onchain.price, "quote vs Registry.getAgent price");
  });
  // Primary-sale split computed here: fee = floor(price * feeBps / 10_000) to the treasury, the rest to the creator.
  const fee = (onchain.price * BigInt(reg.feeBps)) / 10_000n;
  const creatorShare = onchain.price - fee;
  const creator = onchain.creator.toLowerCase() as Hex;
  const treasury = n.deployment.treasury.toLowerCase() as Hex;
  // Extra balance on top of the price. The local anvil charges the sender the fee in the payment's pre-broadcast
  // simulation (eth_call) although RELAY pays it on-chain, so there the agent holds 1 stablecoin (1_000_000 base units)
  // more; elsewhere it holds exactly the price. The debit is checked to the unit either way.
  const slack = n.chainId === 31337 ? 1_000_000n : 0n;
  // The quote's endpoint carries PUBLIC_API_URL; talk to the API under test.
  const endpoint = quote.endpoint.replace(/^https?:\/\/[^/]+/, API_URL);
  const agent = freshAccount();

  await r.step("fresh agent wallet holds only the stablecoin", async (note) => {
    r.tx("faucet agent", (await fund(agent.address, price + slack))[0]);
    note(`${agent.address}: ${fmt(await tokenBalance(agent.address))}`);
  });
  await r.step("no credential -> 402 with WWW-Authenticate: Payment, no-store", async () => {
    const res = await fetch(endpoint, { method: "POST" });
    assertEq(res.status, 402, "status");
    assert(/^Payment /i.test(res.headers.get("www-authenticate") ?? ""), `WWW-Authenticate: ${res.headers.get("www-authenticate")}`);
    assert(/no-store/.test(res.headers.get("cache-control") ?? ""), "Cache-Control is not no-store");
  });
  await r.step("a forged Payment credential is refused and moves nothing", async () => {
    const before = await tokenBalance(agent.address);
    const res = await fetch(endpoint, { method: "POST", headers: { authorization: "Payment eyJmb3JnZWQiOnRydWV9" } });
    assert(res.status >= 400 && res.status < 500 && res.status !== 402, `forged credential answered ${res.status}`);
    assertEq(await tokenBalance(agent.address), before, "balance");
  });

  const mppx = Mppx.create({
    methods: [tempo.charge({ account: agent, mode: "pull", expectedChainId: n.chainId, getClient: () => n.publicClient as never })],
    polyfill: false,
  });
  const before = await tokenBalance(agent.address);
  const beforeSplit = { creator: await tokenBalance(creator), treasury: await tokenBalance(treasury) };
  const order = (await r.step("paid purchase: 402 -> mppx signs (pull) -> server settles and mints to the agent", async (note) => {
    const t0 = Date.now();
    const res = await mppx.fetch(endpoint, { method: "POST" });
    const body = (await res.json()) as Order;
    assertEq(res.status, 200, `status (${JSON.stringify(body).slice(0, 300)})`);
    assertEq([body.status, body.owner?.toLowerCase()], ["fulfilled", agent.address.toLowerCase()], "order");
    r.tx("MPP settlement (agent -> float, fee by RELAY)", body.settlementTx);
    r.tx("license fulfilment (purchaseLicenseFor)", body.txHash);
    note(`${Date.now() - t0} ms, order ${body.orderId}, license #${body.licenseId}`);
    return body;
  }))!;
  await r.step("license in the agent's wallet; exactly the price debited; the agent paid no fee", async () => {
    assertEq(await ownerOf(BigInt(order.licenseId!)), agent.address.toLowerCase(), "ownerOf");
    assertEq(before - (await tokenBalance(agent.address)), onchain.price, "debited = on-chain price");
    const settle = await n.publicClient.getTransactionReceipt({ hash: order.settlementTx! });
    assertEq(settle.from.toLowerCase(), agent.address.toLowerCase(), "settlement sender");
    const relay = (() => {
      try {
        return serverAccount("RELAY_PRIVATE_KEY").address.toLowerCase();
      } catch {
        return null;
      }
    })();
    if (relay) assertEq(feePayerOf(settle), relay, "settlement fee payer");
    else assert(feePayerOf(settle) !== agent.address.toLowerCase(), "the agent paid the fee");
  });
  await r.step("fulfilment split: creator got price - fee, treasury got the fee (Registry feeBps)", async (note) => {
    assert(creator !== treasury, "creator and treasury are the same address");
    const got = { creator: (await tokenBalance(creator)) - beforeSplit.creator, treasury: (await tokenBalance(treasury)) - beforeSplit.treasury };
    assertEq([got.creator, got.treasury], [creatorShare, fee], "creator / treasury received");
    note(`price ${fmt(onchain.price)}, fee ${fmt(fee)} (${reg.feeBps} bps), creator ${fmt(creatorShare)}`);
  });
  await r.step("order status endpoint", async () => {
    const o = await get<Order>(`/api/agent-pay/orders/${order.orderId}`);
    assertEq([o.status, o.licenseId, o.owner?.toLowerCase()], ["fulfilled", order.licenseId, agent.address.toLowerCase()], "order");
  });

  // ---- use it through the connector ----
  const token = (await r.step("agent login in two calls (SIWE by the agent key, memory key)", async (note) => {
    const t = await connectAgent(agent, { memory: true });
    note(`token expires in ${t.expiresIn} s`);
    return t.accessToken;
  }))!;
  // D9: the server indexes the transactions it sends right away, so the license should be listed as soon as the order
  // answered "fulfilled".
  await r.step(
    "list_my_solvers shows the license right after the fulfilled answer (D9: server-sent txs are indexed at once)",
    async () => {
      const mine = await call(token, "list_my_solvers");
      assert(mine.includes(quote.agentId), "the license bought over MPP is not listed yet (the fulfilment tx waits for the indexer poller)");
    },
    { critical: false },
  );
  await r.step("list_my_solvers + activate_solver: access by lifetime license, agent instructions", async (note) => {
    const init = await initialize(token, "e2e-agent");
    assert(/autonomous agent/i.test(init.instructions ?? ""), "no agent instructions");
    const t0 = Date.now();
    await waitFor("the license in list_my_solvers", async () => (await call(token, "list_my_solvers")).includes(quote.agentId), 60_000, 1000);
    note(`listed after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const act = await call(token, "activate_solver", { agent_id: quote.agentId });
    assert(act.includes("Access: lifetime license."), `activate:\n${act.slice(0, 300)}`);
    const sid = sessionIdOf(act)!;
    const step = await call(token, "next_step", { session_id: sid, completed_step: 0 });
    assert(step.includes("You are an autonomous agent") && /# Step 1 of/.test(step), `next_step:\n${step.slice(0, 300)}`);
    if (act.includes("a11y_check")) {
      const out = await call(token, "run_tool", { session_id: sid, tool: "a11y_check", input: { files: { "Bad.tsx": '<div onClick={x}><img src="a.png"/></div>' } } });
      assert((JSON.parse(out) as { issues: unknown[] }).issues.length > 0, "a11y_check found nothing");
    }
    await call(token, "save_memory", { agent_id: quote.agentId, content: "Test agent: prefers short answers." });
    assert((await call(token, "get_memory", { agent_id: quote.agentId })).includes("short answers"), "memory");
  });
  await r.step("second purchase -> 409 already_owned, nothing charged", async () => {
    // Enough balance to pay again, so the refusal comes from the server's ownership check, not from the wallet.
    await fund(agent.address, price + slack);
    const funded = await tokenBalance(agent.address);
    const res = await mppx.fetch(endpoint, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    assertEq([res.status, body.code], [409, "already_owned"], "second purchase");
    assertEq(await tokenBalance(agent.address), funded, "balance");
  });
});
