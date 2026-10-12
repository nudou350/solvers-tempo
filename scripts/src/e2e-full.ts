// The whole demo path through the API and the MCP connector, with one fresh buyer:
//   license purchase (sponsored) -> the connector recognizes the license -> on-chain review (license required) ->
//   license transfer with the royalty (exact creator/platform shares of the original price) -> the new owner gets
//   access, the old one keeps none -> guaranteed task (escrow): deliverable verified through the connector, milestone
//   marked on-chain by the VERIFIER, preview, buyer release, download -> plan milestone (manual review) -> dispute with an
//   agreed criterion -> admin resolves with a refund -> memories in the store (memory-key signature, list, delete) ->
//   guarantee limit, usage, profile and creators endpoints.
//
// Needs: frontend-react listed with its guarantee offer (server with GUARANTEE_MIN_SALES=0 and GUARANTEE_MIN_RATING=0
// for a fresh Solver), VERIFIER_MODE=simulated (or docker), and an admin wallet in ADMIN_WALLETS whose key is in
// SERVER_ENV_FILE (ADMIN_PRIVATE_KEY) or ADMIN_KEY.
//
//   cd scripts && npx tsx src/e2e-full.ts            # API_URL, E2E_SLUG (frontend-react)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feeSplit, royaltySplit } from "@solvers/shared";
import type { Hex } from "viem";
import { API_URL, ROOT, fmt, freshAccount, fund, network, serverAccount, tokenBalance, units } from "./env.js";
import { agentDetail, buyLicense, chainAgent, eventsOf, getConfig, ownerOf, waitFor } from "./lib/flows.js";
import { expectFailure, get } from "./lib/http.js";
import { call, connectOAuth, initialize, sessionIdOf } from "./lib/mcp.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";

type EscrowDetail = {
  escrow: { id: string; title: string; status: string; milestones: { title: string; criteria: string; status: string }[]; autoReleaseAt: string; feeBps: number | null };
  description: string;
  milestones: { index: number; amountUsdc: number; previewUrl: string | null; verify: string; downloadable: boolean; criteria: string[] }[];
};

await run(`e2e-full (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const cfg = await getConfig();
  const detail = await agentDetail(SLUG);
  const agentId = detail.agent.id;
  const agent = await chainAgent(agentId);
  const creator = agent.creator.toLowerCase() as Hex;
  const buyer = new TestWallet(freshAccount(), "buyer");
  const heir = new TestWallet(freshAccount(), "new owner");

  // ---------------- 1. purchase ----------------
  const lic = (await r.step("buyer funded, signs in, buys the license (sponsored)", async (note) => {
    r.tx("faucet buyer", (await fund(buyer.address, agent.price * 3n))[0]);
    await buyer.login();
    const p = await buyLicense(buyer, agentId, agent.price);
    r.tx("license purchase", p.txHash);
    note(`token #${p.tokenId}`);
    return p;
  }))!;

  // ---------------- 2. connector ----------------
  const mcp = (await r.step("connector (OAuth) lists the license and activates with lifetime access", async (note) => {
    const t = await connectOAuth(buyer.account, { memory: true });
    await initialize(t.accessToken);
    const list = await call(t.accessToken, "list_my_solvers");
    assert(list.includes(agentId) && list.includes("lifetime license"), `list_my_solvers:\n${list.slice(0, 500)}`);
    const act = await call(t.accessToken, "activate_solver", { agent_id: agentId });
    assert(act.includes("Access: lifetime license."), `activate_solver:\n${act.slice(0, 400)}`);
    const sid = sessionIdOf(act);
    assert(sid, "no session id");
    note(sid);
    return { token: t.accessToken, sessionId: sid };
  }))!;

  // ---------------- 3. review ----------------
  await r.step("on-chain review with the license; a wallet without one is refused (403)", async () => {
    const text = "Components come with real tests. Recommended.";
    const built = await buyer.post<{ calls: { to: Hex; data: Hex }[] }>("/api/tx/review", { agentId, rating: 5, text });
    const c = await buyer.sendAndConfirm(built.calls);
    r.tx("review", c.txHash);
    assert((await eventsOf(c.receipt)).some((e) => e.eventName === "ReviewSubmitted"), "no ReviewSubmitted");
    const reviews = await get<{ authorWallet: string; text: string; rating: number }[]>(`/api/agents/${SLUG}/reviews`);
    assert(reviews.some((x) => x.authorWallet.toLowerCase() === buyer.lower && x.text.includes("Recommended")), "review not published");
    const stranger = await new TestWallet(freshAccount(), "stranger").login();
    await expectFailure(stranger.post("/api/tx/review", { agentId, rating: 1, text: "Never used it." }), 403);
  });

  // ---------------- 4. transfer with royalty ----------------
  await r.step("license transfer: exact creator + platform shares of the original price, new owner gets access", async (note) => {
    const exp = royaltySplit(agent.price, agent.royaltyBps, cfg.royalty.platformBps ?? 0);
    if (agent.royaltyBps === 500 && cfg.royalty.platformBps === 500) {
      assertEq(exp.creatorAmount, (agent.price * 500n) / 10_000n, "5% creator");
      assertEq(exp.platformAmount, (agent.price * 500n) / 10_000n, "5% platform");
    }
    const q = await buyer.get<{ totalUnits: string }>(`/api/me/licenses/${lic.tokenId}/transfer-quote`);
    assertEq(BigInt(q.totalUnits), exp.total, "quote");
    const before = { buyer: await tokenBalance(buyer.address), creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
    const built = await buyer.post<{ calls: { to: Hex; data: Hex }[] }>("/api/tx/transfer", { licenseId: lic.tokenId.toString(), to: heir.address, maxRoyaltyUnits: q.totalUnits });
    const c = await buyer.sendAndConfirm(built.calls);
    r.tx("transfer with royalty", c.txHash);
    const after = { buyer: await tokenBalance(buyer.address), creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
    assertEq(
      [before.buyer - after.buyer, after.creator - before.creator, after.treasury - before.treasury],
      [exp.total, exp.creatorAmount, exp.platformAmount],
      "owner paid / creator got / treasury got",
    );
    assertEq(await ownerOf(lic.tokenId), heir.lower, "ownerOf");
    // The old owner's session no longer carries the license; the new owner's connector does.
    const heirMcp = await connectOAuth(heir.account, { memory: false });
    const heirAct = await call(heirMcp.accessToken, "activate_solver", { agent_id: agentId });
    assert(heirAct.includes("Access: lifetime license."), `new owner activate:\n${heirAct.slice(0, 300)}`);
    const oldAct = await call(mcp.token, "activate_solver", { agent_id: agentId });
    assert(!oldAct.includes("Access: lifetime license."), `old owner still has the license:\n${oldAct.slice(0, 300)}`);
    note(`${fmt(exp.creatorAmount)} + ${fmt(exp.platformAmount)} of ${fmt(agent.price)}`);
  });
  await r.step("the new owner cannot back a second review with the already-reviewed license (400 license_already_reviewed)", async () => {
    await heir.login();
    await expectFailure(heir.post("/api/tx/review", { agentId, rating: 4, text: "Second review with the same license." }), 400, "license_already_reviewed");
  });

  // ---------------- 5. guarantee ----------------
  const offer = detail.guarantee;
  if (!offer) {
    r.skip("guarantee flow", `${SLUG} has no guarantee offer on this server (needs GUARANTEE_MIN_SALES=0 and GUARANTEE_MIN_RATING=0 for a fresh Solver)`);
  } else {
    const dir = join(ROOT, "agents", "frontend-react", "verifier", "example");
    const files = { "LoginForm.tsx": readFileSync(join(dir, "LoginForm.tsx"), "utf8"), "LoginForm.test.tsx": readFileSync(join(dir, "LoginForm.test.tsx"), "utf8") };
    const escrowId = (await r.step("guaranteed task: intent -> sponsored createEscrow -> texts mirrored", async (note) => {
      const intent = await buyer.post<{ calls: { to: Hex; data: Hex }[]; amountUnits: string }>("/api/purchases/intent", {
        kind: "escrow",
        agentId,
        task: {
          title: "Login form",
          description: "Login form with e-mail and password, validation on submit and accessible error messages.",
          acceptanceTests: [null, { "LoginForm.test.tsx": files["LoginForm.test.tsx"] }],
        },
      });
      const c = await buyer.sendAndConfirm(intent.calls);
      r.tx("createEscrow", c.txHash);
      const ev = (await eventsOf(c.receipt)).find((e) => e.eventName === "EscrowCreated");
      assert(ev, "no EscrowCreated");
      const id = (ev.args as { escrowId: bigint }).escrowId.toString();
      const d = await waitFor("escrow texts", async () => {
        const x = await buyer.get<EscrowDetail>(`/api/me/escrows/${id}`);
        return x.escrow.title === "Login form" && x.description ? x : null;
      }, 30_000);
      assertEq(d.milestones.length, offer.milestones.length, "milestones");
      note(`escrow ${id}, ${fmt(BigInt(intent.amountUnits))} locked`);
      return id;
    }))!;

    const session = (await r.step("the buyer's connector session gets guarantee access", async () => {
      const act = await call(mcp.token, "activate_solver", { agent_id: agentId });
      const sid = sessionIdOf(act);
      assert(sid && /guaranteed task/i.test(act), `activate with an open guarantee:\n${act.slice(0, 400)}`);
      return sid;
    }))!;
    await r.step("deliverable: acceptance tests cannot be replaced; a delivery without the component fails", async () => {
      const reserved = await call(mcp.token, "submit_deliverable", {
        session_id: session,
        escrow_id: escrowId,
        milestone: 1,
        artifact: { files: { ...files, "acceptance.LoginForm.test.tsx": "it('ok',()=>{})" } },
      }).catch((e: Error) => e);
      assert(reserved instanceof Error, "a delivery overwrote the acceptance suite");
      const bad = await call(mcp.token, "submit_deliverable", { session_id: session, escrow_id: escrowId, milestone: 1, artifact: { files: { "NOTES.md": "no component" } } });
      assert(bad.startsWith("Verification failed"), `bad delivery:\n${bad.slice(0, 300)}`);
    });
    const preview = (await r.step("good delivery passes; the VERIFIER marks the milestone on-chain; watermarked preview", async (note) => {
      const good = await call(mcp.token, "submit_deliverable", { session_id: session, escrow_id: escrowId, milestone: 1, artifact: { files } });
      assert(good.startsWith("Verification passed"), `good delivery:\n${good.slice(0, 300)}`);
      const url = /Preview: (\S+)/.exec(good)?.[1];
      assert(url, "no preview link");
      const local = url.replace(/^https?:\/\/[^/]+/, API_URL);
      const pv = await fetch(local);
      assert(pv.status === 200 && (await pv.text()).includes("PREVIEW"), `preview ${pv.status}`);
      const pvBad = await fetch(local.replace(/t=[^&]+/, "t=wrong"));
      assertEq(pvBad.status, 404, "preview with a wrong token");
      const d = await waitFor("milestone passed", async () => {
        const x = await buyer.get<EscrowDetail>(`/api/me/escrows/${escrowId}`);
        return x.escrow.milestones[1]!.status === "passed" ? x : null;
      }, 60_000);
      assert(d.escrow.autoReleaseAt, "no auto-release date");
      note(url.split("?")[0]!);
      return d;
    }))!;
    await r.step("download is blocked before approval; buyer releases (exact fee split); then downloads", async (note) => {
      await expectFailure(buyer.get(`/api/me/escrows/${escrowId}/milestones/1/download`), 403);
      const amount = units(preview.milestones[1]!.amountUsdc);
      const { fee, rest } = feeSplit(amount, preview.escrow.feeBps ?? cfg.feeBps ?? 0);
      const before = { creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
      const built = await buyer.post<{ calls: { to: Hex; data: Hex }[] }>(`/api/tx/escrow/${escrowId}/release`, { index: 1 });
      const c = await buyer.sendAndConfirm(built.calls);
      r.tx("releaseMilestone", c.txHash);
      const after = { creator: await tokenBalance(creator), treasury: await tokenBalance(n.deployment.treasury) };
      assertEq([after.creator - before.creator, after.treasury - before.treasury], [rest, fee], "creator / treasury on release");
      const dl = await waitFor("download", () => buyer.get<{ files: Record<string, string> }>(`/api/me/escrows/${escrowId}/milestones/1/download`), 30_000);
      assert(dl.files["LoginForm.tsx"], "download without the component");
      note(`creator +${fmt(rest)}, treasury +${fmt(fee)}`);
    });
    await r.step("plan milestone (manual review) is delivered for the buyer's review", async () => {
      const plan = await call(mcp.token, "submit_deliverable", {
        session_id: session,
        escrow_id: escrowId,
        milestone: 0,
        artifact: { files: { "PLAN.md": "# Plan\n- Props: onSubmit, isLoading\n- Test cases: empty submit, invalid e-mail, success" } },
      });
      assert(plan.startsWith("Delivery received for the user's review."), `plan:\n${plan.slice(0, 300)}`);
      await waitFor("plan passed", async () => (await buyer.get<EscrowDetail>(`/api/me/escrows/${escrowId}`)).escrow.milestones[0]!.status === "passed", 60_000);
    });
    await r.step("dispute needs an agreed criterion; the admin resolves with a full refund", async (note) => {
      await expectFailure(buyer.post(`/api/tx/escrow/${escrowId}/dispute`, { index: 0, criterion: "something made up", reason: "It was not delivered." }), 400, "invalid_criterion");
      const criterion = offer.milestones[0]!.criteria[0]!;
      const built = await buyer.post<{ calls: { to: Hex; data: Hex }[] }>(`/api/tx/escrow/${escrowId}/dispute`, { index: 0, criterion, reason: "The plan does not list the props." });
      const c = await buyer.sendAndConfirm(built.calls);
      r.tx("openDispute", c.txHash);
      const admin = await new TestWallet(serverAccount("ADMIN_PRIVATE_KEY", process.env.ADMIN_KEY), "admin").login();
      await waitFor("dispute listed for the admin", async () => {
        const list = await admin.get<{ escrowId: string; index: number; criterion: string | null }[]>("/api/admin/disputes");
        return list.find((x) => x.escrowId === escrowId && x.index === 0 && x.criterion === criterion);
      }, 30_000);
      const amount = units(preview.milestones[0]!.amountUsdc);
      const before = await tokenBalance(buyer.address);
      const res = await admin.post<{ txHash: Hex }>(`/api/admin/escrow/${escrowId}/resolve`, { index: 0, refund: true });
      r.tx("resolveDispute (refund)", res.txHash);
      await n.publicClient.waitForTransactionReceipt({ hash: res.txHash });
      assertEq((await tokenBalance(buyer.address)) - before, amount, "refund to the buyer");
      await waitFor("milestone refunded", async () => (await buyer.get<EscrowDetail>(`/api/me/escrows/${escrowId}`)).escrow.milestones[0]!.status === "refunded", 30_000);
      note(`refunded ${fmt(amount)}`);
    });
  }

  // ---------------- 6. memories ----------------
  await r.step("memories in the store: locked without the key, unlocked by the wallet signature, listed and deleted", async (note) => {
    await call(mcp.token, "save_memory", { agent_id: agentId, content: "Uses Next.js 15 and prefers CSS Modules." });
    await expectFailure(buyer.get("/api/me/memories"), 409, "memory_key_required");
    await buyer.post("/api/me/memory-key", { signature: await buyer.memorySignature() });
    const mems = await buyer.get<{ id: string; summary: string }[]>("/api/me/memories");
    assert(mems.some((m) => m.summary.includes("CSS Modules")), `memories: ${JSON.stringify(mems).slice(0, 300)}`);
    await buyer.request("DELETE", `/api/me/memories/${mems[0]!.id}`);
    note(`${mems.length} memory(ies)`);
  });

  // ---------------- 7. account endpoints ----------------
  await r.step("guarantee limit, usage, profile, reputation and creators endpoints", async () => {
    const g = await buyer.get<{ limitUsdc: number; openUsdc: number; availableUsdc: number }>("/api/me/guarantee");
    assertEq(g.availableUsdc, Math.max(0, g.limitUsdc - g.openUsdc), "guarantee available");
    const usage = await buyer.get<{ weekly: number[] }[]>("/api/me/usage");
    assert(Array.isArray(usage), "usage");
    await buyer.request("PATCH", "/api/me/profile", { displayName: "E2E Buyer", email: "E2E@Example.com" });
    const prof = await buyer.get<{ displayName: string; email: string; memberSince: string }>("/api/me/profile");
    assertEq([prof.displayName, prof.email], ["E2E Buyer", "e2e@example.com"], "profile");
    const rep = await buyer.get<{ purchases: number }>("/api/me/reputation");
    assert(rep.purchases >= 1, `reputation: ${JSON.stringify(rep)}`);
    const creators = await get<{ id: string }[]>("/api/creators");
    assert(creators.some((c) => c.id === detail.agent.creatorId), "the Solver's creator is not listed");
  });
});
