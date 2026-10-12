// Publishes ONE test Solver through the real creator flow on any network (Moderato included), then buys and uses it:
//   invite (cli:invite) -> creator SIWE sign-in + profile -> ZIP upload -> worker validation -> admin review on the
//   site (signs nothing) -> creator co-signs `[approve(staking)?, registerAgent, ...]` through the relay ->
//   /api/tx/publication/confirm -> `cli:approve <submissionId>` (cold admin key, fee by RELAY) -> published and listed
//   -> a buyer purchases it (direct wallet, sponsored) and activates it through the connector.
//
// The package is the QA package (lib/qa-package.ts) under a unique slug (`e2e-<random>`), price = the on-chain minimum,
// creator royalty 500 bps. The creator key is kept under scripts/.keys/creators/<slug>.key for later updates.
// The server CLIs run with SERVER_ENV_FILE (default apps/server/.env) and must point at the same database as the API.
// The API needs the submission worker (SUBMISSIONS_INLINE=true or the solvers-tempo-worker process) and an admin wallet
// in ADMIN_WALLETS whose key is ADMIN_PRIVATE_KEY in SERVER_ENV_FILE (or ADMIN_KEY).
//
//   cd scripts && npx tsx src/publish-test-agent.ts
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { solversRegistryAbi } from "@solvers/contracts-client";
import type { Hex } from "viem";
import { API_URL, SERVER_DIR, SERVER_ENV_FILE, childEnv, fmt, freshAccount, fund, namedAccount, network, serverAccount, sleep } from "./env.js";
import { agentDetail, buyLicense, chainAgent } from "./lib/flows.js";
import { request } from "./lib/http.js";
import { call, connectOAuth, sessionIdOf } from "./lib/mcp.js";
import { qaPackageFiles, zipOfFiles } from "./lib/qa-package.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

const CHECKLIST = { promiseDelivered: true, twoDifferentiatorsProven: true, rightsAndSources: true, noHarmfulInstructions: true, priceTrialShowcaseCoherent: true };

/**
 * Runs a server CLI with SERVER_ENV_FILE (never another env file); its values are set explicitly so a DATABASE_URL,
 * CHAIN_ID, RPC_URL or key exported in the shell cannot override them.
 */
function cli(name: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [`--env-file=${SERVER_ENV_FILE}`, "--import", "tsx", `src/cli/${name}.ts`, ...args], {
    cwd: SERVER_DIR,
    env: childEnv(SERVER_ENV_FILE),
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

type Submission = { id: string; status: string; slug: string; version: string; validation?: { errors?: { code: string }[] } | null };

await run(`publish-test-agent (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const slug = `e2e-${randomBytes(3).toString("hex")}`;
  const creator = new TestWallet(namedAccount(`creators/${slug}`), "creator");
  const admin = new TestWallet(serverAccount("ADMIN_PRIVATE_KEY", process.env.ADMIN_KEY), "admin");

  const invite = (await r.step("invite code from cli:invite", async (note) => {
    const res = cli("invite", ["create", "--note", `e2e ${slug}`]);
    assertEq(res.code, 0, `cli:invite exit (${res.out.slice(-300)})`);
    const code = res.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()!;
    assert(code, "cli:invite printed no code");
    note("code received (not printed)");
    return code;
  }))!;
  await r.step("creator signs in (SIWE) and creates the profile with the invite", async () => {
    await creator.login();
    const me = await creator.post<{ hasProfile: boolean; invited: boolean }>("/api/creator/profile", { name: "E2E Creator", bio: "Test creator profile used by the e2e scripts.", acceptTerms: true, inviteCode: invite });
    assert(me.hasProfile && me.invited, `profile: ${JSON.stringify(me)}`);
  });
  const price = await n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "minPrice" });
  const sub = (await r.step("ZIP upload -> worker validation -> pending_review", async (note) => {
    const files = qaPackageFiles({ slug, priceUsdc: Number(price) / 1e6, manifest: { pricing: { priceUsdc: Number(price) / 1e6, royaltyBps: 500 } } });
    const up = await request<{ id: string; status: string }>("POST", "/api/creator/submissions", { token: creator.token, headers: { "content-type": "application/zip" }, raw: new Uint8Array(zipOfFiles(files, slug)) });
    const t0 = Date.now();
    let s: Submission | undefined;
    while (Date.now() - t0 < 300_000) {
      s = await creator.get<Submission>(`/api/creator/submissions/${up.id}`);
      if (!["submitted", "validating"].includes(s.status)) break;
      await sleep(1500);
    }
    assertEq(s?.status, "pending_review", `status (validation: ${JSON.stringify(s?.validation?.errors ?? [])})`);
    note(`${up.id} (${slug} v${s!.version}) validated in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return s!;
  }))!;
  await r.step("admin approves on the site (signs nothing on-chain)", async (note) => {
    await admin.login();
    const res = await admin.post<{ status: string; approved: { versionHash: string; priceUsdc: string; royaltyBps: number } }>(`/api/admin/submissions/${sub.id}/approve`, {
      notes: "Approved by the e2e publish script.",
      checklist: CHECKLIST,
    });
    assertEq([res.status, res.approved.royaltyBps], ["awaiting_creator_signature", 500], "after approval");
    note(`versionHash ${res.approved.versionHash.slice(0, 16)}...`);
  });
  const minStake = await n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "minStake" });
  if (minStake > 0n) {
    await r.step("creator funded with the minimum stake (the registration batch deposits it)", async (note) => {
      for (const h of await fund(creator.address, minStake)) r.tx("faucet creator (stake)", h);
      note(`stake ${fmt(minStake)}`);
    });
  }
  await r.step("creator co-signs the registration through the relay; publication confirm", async (note) => {
    const plan = await creator.get<{ step: string | null }>(`/api/tx/publication/${sub.id}`);
    assertEq(plan.step, "register-agent", "plan step");
    const built = await creator.post<{ calls: { to: Hex; data: Hex }[] }>("/api/tx/register-agent", { submissionId: sub.id });
    const { hash } = await creator.send(built.calls);
    r.tx("registerAgent (creator, sponsored)", hash);
    const res = await creator.post<{ status: string; outcome: string; step: string | null }>("/api/tx/publication/confirm", { submissionId: sub.id, txHash: hash, kind: "register-agent" });
    // "busy": the indexer is finalizing the same submission right now (it saw AgentRegistered); poll the submission.
    assert(["not_ready", "busy"].includes(res.outcome), `confirm outcome: ${JSON.stringify(res)}`);
    const t0 = Date.now();
    let status = res.status;
    while (status !== "awaiting_onchain_approval" && Date.now() - t0 < 60_000) {
      await sleep(1500);
      status = (await creator.get<Submission>(`/api/creator/submissions/${sub.id}`)).status;
    }
    assertEq(status, "awaiting_onchain_approval", `status after confirm (${JSON.stringify(res)})`);
    note(`confirm outcome ${res.outcome}`);
  });
  const agentId = (await r.step("cli:approve <submissionId>: approveAgent with the admin key, then the publication finishes", async (note) => {
    const res = cli("approve", [sub.id]);
    assertEq(res.code, 0, `cli:approve exit:\n${res.out.slice(-800)}`);
    for (const h of res.out.match(/0x[0-9a-f]{64}/gi) ?? []) r.tx("cli:approve", h);
    const s = await creator.get<Submission & { agentId?: string }>(`/api/creator/submissions/${sub.id}`);
    assertEq(s.status, "published", "submission status");
    const d = await agentDetail(slug);
    assertEq((await chainAgent(d.agent.id)).status, 1, "on-chain status Active");
    note(`${slug} = ${d.agent.id}`);
    return d.agent.id;
  }))!;
  await r.step("a buyer purchases the new Solver (sponsored) and activates it through the connector", async (note) => {
    const buyer = new TestWallet(freshAccount(), "buyer");
    r.tx("faucet buyer", (await fund(buyer.address, price))[0]);
    await buyer.login();
    const p = await buyLicense(buyer, agentId, price);
    r.tx("purchase", p.txHash);
    const { accessToken } = await connectOAuth(buyer.account, { memory: false });
    const act = await call(accessToken, "activate_solver", { agent_id: agentId });
    assert(sessionIdOf(act) && act.includes("Access: lifetime license."), `activate:\n${act.slice(0, 300)}`);
    note(`license #${p.tokenId} for ${fmt(price)}`);
  });
});
