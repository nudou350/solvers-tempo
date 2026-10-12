// An autonomous agent that holds its own key USES a Solver through the MCP connector: two-call agent login (SIWE by
// the key), then list / activate (lifetime license) / preflight / next_step / search_knowledge / run_tool / memory,
// token refresh and an invalid-token check. Without a license yet, the agent buys one DIRECTLY on-chain
// (`[approve, purchaseLicense]` with its own purchase id), sponsored by the platform relay under its agent OAuth token,
// i.e. the direct-wallet path an agent with a wallet can use instead of MPP.
//
//   cd scripts && npx tsx src/e2e-agent-use.ts      # E2E_AGENT_KEY (hex or key file; default: a fresh key), E2E_SLUG
import { loadPrivateKey, purchaseLicenseCalls } from "@solvers/chain";
import { agentIdToBytes32 } from "@solvers/shared";
import { privateKeyToAccount } from "viem/accounts";
import { API_URL, freshAccount, fund, network } from "./env.js";
import { call, connectAgent, initialize, refreshAgent, rpc, sessionIdOf } from "./lib/agent-client.js";
import { agentDetail, chainAgent, mintedTokenId, ownerOf, randomHex32, waitFor } from "./lib/flows.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";

await run(`e2e-agent-use (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const account = process.env.E2E_AGENT_KEY ? privateKeyToAccount(loadPrivateKey(process.env.E2E_AGENT_KEY, "E2E_AGENT_KEY")) : freshAccount();
  const detail = await agentDetail(SLUG);
  const agentId = detail.agent.id;

  let tokens = (await r.step("agent login in two calls (SIWE signed by the agent key, memory key)", async (note) => {
    const t = await connectAgent(account, { memory: true });
    note(account.address);
    return t;
  }))!;
  const listed = async () => (await call(tokens.accessToken, "list_my_solvers")).includes(agentId);

  if (!(await listed())) {
    await r.step("no license yet: the agent buys directly on-chain, sponsored by the relay under its agent token", async (note) => {
      const price = (await chainAgent(agentId)).price;
      r.tx("faucet agent", (await fund(account.address, price))[0]);
      const w = new TestWallet(account, "agent");
      const { hash, receipt } = await w.send(purchaseLicenseCalls(n.deployment, { agentId: agentIdToBytes32(agentId), price, purchaseId: randomHex32() }), tokens.accessToken);
      r.tx("direct purchase (agent)", hash);
      const tokenId = await mintedTokenId(receipt);
      assertEq(await ownerOf(tokenId), account.address.toLowerCase(), "ownerOf");
      await waitFor("the license in list_my_solvers (indexer)", listed, 60_000, 1000);
      note(`license #${tokenId}`);
    });
  }

  await r.step("initialize: agent instructions; 15 tools", async () => {
    const init = await initialize(tokens.accessToken, "e2e-agent-use");
    assert(/autonomous agent/i.test(init.instructions ?? ""), "no agent instructions");
    assertEq((await rpc(tokens.accessToken, "tools/list")).tools?.length, 15, "tools");
  });
  const session = (await r.step("activate_solver: access by lifetime license, no human checkout text", async () => {
    const act = await call(tokens.accessToken, "activate_solver", { agent_id: agentId });
    assert(act.includes("Access: lifetime license."), `activate:\n${act.slice(0, 300)}`);
    assert(!/\/checkout/i.test(act), "a human checkout link leaked to the agent");
    const sid = sessionIdOf(act);
    assert(sid, "no session id");
    return { sid, act };
  }))!;
  await r.step("preflight, next_step (agent note), search_knowledge, run_tool", async (note) => {
    const pre = await call(tokens.accessToken, "preflight_check", { session_id: session.sid, available_tools: ["solvers:next_step"] });
    assert(pre.startsWith("All set") || pre.startsWith("Missing requirements"), `preflight:\n${pre.slice(0, 200)}`);
    const step = await call(tokens.accessToken, "next_step", { session_id: session.sid, completed_step: 0 });
    assert(step.includes("You are an autonomous agent"), `next_step:\n${step.slice(0, 300)}`);
    const kb = await call(tokens.accessToken, "search_knowledge", { session_id: session.sid, query: "best practices" });
    assert(kb.length > 40, "empty knowledge answer");
    if (session.act.includes("a11y_check")) {
      const out = await call(tokens.accessToken, "run_tool", {
        session_id: session.sid,
        tool: "a11y_check",
        input: { files: { "Bad.tsx": '<div onClick={x}><img src="a.png"/><input id="e"/></div>' } },
      });
      note(`a11y_check: ${(JSON.parse(out) as { issues: unknown[] }).issues.length} issues`);
    } else note("no a11y_check in this Solver");
  });
  await r.step("memory round trip", async () => {
    await call(tokens.accessToken, "save_memory", { agent_id: agentId, content: "Test agent: prefers short answers." });
    assert((await call(tokens.accessToken, "get_memory", { agent_id: agentId })).includes("short answers"), "memory did not come back");
  });
  await r.step("refresh token (client_id agent) rotates and the new access token works", async () => {
    const next = await refreshAgent(tokens.refreshToken);
    const reuse = await fetch(`${API_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: "agent" }),
    });
    assertEq(reuse.status, 400, "old refresh token reused");
    tokens = next;
    assert(await listed(), "the new token does not see the license");
  });
  await r.step("invalid token -> 401", async () => {
    const bad = await fetch(`${API_URL}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer invalid" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEq(bad.status, 401, "status");
  });
});
