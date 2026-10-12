// Smoke test of the Solver Creator (criador-de-solvers) on a real server, spending nothing: it is a free platform
// Solver (database only). A fresh agent key logs in with the two-call agent login (SIWE, no browser), activates the
// Solver Creator, reads step 1, validates a manifest through `validate_package`, asks for a template, searches the
// knowledge base and checks the memory calibration. Exits 1 if any check fails.
//
//   cd scripts && API_URL=http://127.0.0.1:3028 npx tsx src/smoke-creator.ts
//   API_URL=https://<domain> npx tsx src/smoke-creator.ts
import { freshAccount } from "./env.js";
import { call, connectAgent, initialize, rpc, sessionIdOf } from "./lib/agent-client.js";
import { assert, run } from "./lib/report.js";

const CREATOR_SOLVER_ID = "c71ad0a50f750e75c71ad0a50f750e75";

await run("smoke-creator (Solver Creator over MCP)", async (r) => {
  const account = freshAccount();
  let token = "";
  await r.step("agent login (two calls, SIWE) and initialize", async () => {
    token = (await connectAgent(account, { memory: true })).accessToken;
    await initialize(token, "smoke");
    return account.address;
  });
  await r.step("the connector exposes get_template and forget_memory", async () => {
    const tools = (await rpc(token, "tools/list")).tools?.map((t) => t.name) ?? [];
    assert(tools.includes("get_template") && tools.includes("forget_memory"), tools.join(","));
    return `${tools.length} tools`;
  }, { critical: false });
  await r.step("find_solver finds the Solver Creator (free)", async () => {
    const found = await call(token, "find_solver", { need: "I want to create and publish my own Solver, build the package and send it for review" });
    assert(found.includes(CREATOR_SOLVER_ID), found.slice(0, 400));
  }, { critical: false });
  let session = "";
  await r.step("activate_solver opens a session without license or free trial", async () => {
    const act = await call(token, "activate_solver", { agent_id: CREATOR_SOLVER_ID });
    session = sessionIdOf(act) ?? "";
    assert(session && !/checkout|Free trial \(use|free trial (ended|is over)/i.test(act.slice(0, 600)), act.slice(0, 300));
    return session;
  });
  await r.step("preflight tells the model to call get_memory (calibration)", async () => {
    const pre = await call(token, "preflight_check", { session_id: session, available_tools: ["solvers:next_step", "web_search"] });
    assert(/get_memory/.test(pre), pre.slice(0, 300));
  }, { critical: false });
  await r.step("get_memory returns the calibration questions; skipping stores a skipped profile", async () => {
    const mem = await call(token, "get_memory", { agent_id: CREATOR_SOLVER_ID });
    assert(/needs_onboarding/.test(mem), mem.slice(0, 200));
    await call(token, "save_memory", { agent_id: CREATOR_SOLVER_ID, kind: "profile", content: JSON.stringify({ skipped: true }) });
    assert(!/needs_onboarding/.test(await call(token, "get_memory", { agent_id: CREATOR_SOLVER_ID })), "still needs onboarding after skipping");
  }, { critical: false });
  await r.step("next_step delivers step 1", async () => {
    const step = await call(token, "next_step", { session_id: session });
    // Agent sessions start with the autonomous-agent header, then the step.
    assert(/^# Step 1\b/m.test(step), step.slice(0, 200));
    return step.split("\n").find((l) => l.startsWith("# Step 1"))!;
  }, { critical: false });
  await r.step("validate_package points out errors with code and fix", async () => {
    const bad = await call(token, "run_tool", {
      session_id: session,
      tool: "validate_package",
      input: { manifest: { specVersion: 1, slug: "x", platform: true }, steps: [{ file: "steps/01.md", content: "# Step" }] },
    });
    const parsed = JSON.parse(bad) as { ok: boolean; errors: { code: string; fix?: string }[] };
    assert(parsed.ok === false && parsed.errors.length > 0 && parsed.errors.every((e) => e.code && e.fix), bad.slice(0, 300));
    return `${parsed.errors.length} errors`;
  }, { critical: false });
  await r.step("get_template returns a manifest skeleton", async () => {
    const tpl = await call(token, "get_template", { session_id: session, name: "manifest-esqueleto" });
    assert(/specVersion/.test(tpl), tpl.slice(0, 120));
  }, { critical: false });
  await r.step("search_knowledge answers with a source", async () => {
    const kn = await call(token, "search_knowledge", { session_id: session, query: "how to write the calibration questions" });
    assert(kn.length > 80 && /source/i.test(kn), kn.slice(0, 200));
  }, { critical: false });
});
