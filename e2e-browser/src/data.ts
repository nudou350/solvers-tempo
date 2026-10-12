// Test data set up through the API (not the scenario under test): a license bought with the same key the browser's
// dev wallet uses, so a scenario can start from "the buyer owns this Solver".
import "./env.js";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { buyLicense } from "../../scripts/src/lib/flows.js";
import { call, connectOAuth, sessionIdOf } from "../../scripts/src/lib/mcp.js";
import { TestWallet } from "../../scripts/src/lib/wallet.js";
import { agentDetail, chainAgent, eventsOf, fund, units } from "./chain.js";
import type { Evidence } from "./fixtures.js";

/** Funds `account` with `price + extra` and buys a license of `slug` directly (SIWE + intent + relay). */
export async function ownLicense(ev: Evidence, account: PrivateKeyAccount, slug: string, extra = 0n) {
  const d = await agentDetail(slug);
  const price = (await chainAgent(d.agent.id)).price;
  for (const h of await fund(account.address, price + extra)) await ev.tempo("test funds (anvil funder)", h);
  const w = await new TestWallet(account, "owner").login();
  const p = await buyLicense(w, d.agent.id, price);
  await ev.tempo(`setup: license of ${slug} bought through the API`, p.txHash);
  return { tokenId: p.tokenId, price, agentId: d.agent.id, name: d.agent.name, wallet: w };
}

/**
 * The Solver's side of a guaranteed task, as the buyer's AI does it through the connector (OAuth as the buyer's wallet,
 * activate_solver, submit_deliverable): delivers the manual-review milestone 0 (a plan) and waits until the server marks
 * it passed. Returns the connector's answer.
 */
export async function deliverPlan(account: PrivateKeyAccount, agentId: string, escrowId: string): Promise<string> {
  const { accessToken } = await connectOAuth(account, { memory: false });
  const act = await call(accessToken, "activate_solver", { agent_id: agentId });
  const session = sessionIdOf(act);
  if (!session) throw new Error(`activate_solver gave no session:\n${act.slice(0, 300)}`);
  const answer = await call(accessToken, "submit_deliverable", {
    session_id: session,
    escrow_id: escrowId,
    milestone: 0,
    artifact: { files: { "PLAN.md": "# Plan\n- Props: onSubmit, isLoading\n- States: idle, submitting, error\n- Test cases: empty submit, invalid e-mail, success" } },
  });
  if (!answer.startsWith("Delivery received for the user's review.")) throw new Error(`submit_deliverable:\n${answer.slice(0, 300)}`);
  return answer;
}

/** A guaranteed task created through the API (intent + sponsored createEscrow), for scenarios that start after it. */
export async function ownEscrow(ev: Evidence, account: PrivateKeyAccount, slug: string): Promise<{ escrowId: string; agentId: string; total: bigint; wallet: TestWallet }> {
  const d = await agentDetail(slug);
  if (!d.guarantee) throw new Error(`${slug} offers no guarantee`);
  const total = units(d.guarantee.priceUsdc);
  for (const h of await fund(account.address, total)) await ev.tempo("test funds (anvil funder)", h);
  const w = await new TestWallet(account, "buyer").login();
  const intent = await w.post<{ calls: { to: Hex; data: Hex }[] }>("/api/purchases/intent", {
    kind: "escrow",
    agentId: d.agent.id,
    task: { title: "Signup form", description: "Signup form with e-mail and password, validation on submit and accessible error messages." },
  });
  const c = await w.sendAndConfirm(intent.calls);
  await ev.tempo(`setup: guaranteed task with ${slug} created through the API`, c.txHash);
  const created = (await eventsOf(c.receipt)).find((e) => e.eventName === "EscrowCreated");
  if (!created) throw new Error("no EscrowCreated in the setup transaction");
  return { escrowId: (created.args as { escrowId: bigint }).escrowId.toString(), agentId: d.agent.id, total, wallet: w };
}
