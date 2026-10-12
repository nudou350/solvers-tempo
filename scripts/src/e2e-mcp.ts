// The MCP connector end to end, playing Claude/ChatGPT: discovery from the 401 of /mcp, dynamic client registration,
// consent signed with SIWE (plus the memory key), code exchange with PKCE S256, then the tools: list, find, activate
// (free trial), preflight, steps, knowledge, run_tool and memory, checking the free-trial limits (a step, search or tool
// run beyond the trial answers with the end-of-trial text, never an error). Also: refresh token rotation, invalid
// token -> 401, another wallet cannot drive the session. A Solver without a free trial skips only the trial checks (the
// run then fails unless E2E_ALLOW_SKIP=1); the session checks use the free platform Solver Creator instead.
//
//   cd scripts && npx tsx src/e2e-mcp.ts            # API_URL, E2E_SLUG (default frontend-react: has a trial and a11y_check)
import { API_URL, freshAccount, network } from "./env.js";
import { agentDetail } from "./lib/flows.js";
import { call, connectOAuth, initialize, rpc, sessionIdOf } from "./lib/mcp.js";
import { assert, assertEq, run } from "./lib/report.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";
const NEED = process.env.E2E_NEED ?? "I need an accessible React login form with tests";
/** The free platform Solver Creator (criador-de-solvers): used for the session checks when the Solver has no trial. */
const CREATOR_SOLVER_ID = "c71ad0a50f750e75c71ad0a50f750e75";

await run(`e2e-mcp (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  const user = freshAccount();
  const detail = await agentDetail(SLUG);
  const agentId = detail.agent.id;
  const trial = detail.trial;

  const oauth = (await r.step("OAuth: 401 discovery -> DCR -> SIWE consent (+ memory key) -> PKCE code exchange", async (note) => {
    const t = await connectOAuth(user, { memory: true });
    note(`client ${t.clientId}, wallet ${user.address}`);
    return t;
  }))!;
  const token = oauth.accessToken;

  await r.step("initialize and tools/list (15 tools incl. get_template)", async (note) => {
    const init = await initialize(token);
    assert(typeof init.instructions === "string" && init.instructions.length > 20, "no server instructions");
    const tools = (await rpc(token, "tools/list")).tools?.map((t) => t.name) ?? [];
    assertEq(tools.length, 15, `tool count (${tools.join(", ")})`);
    for (const t of ["list_my_solvers", "find_solver", "activate_solver", "preflight_check", "next_step", "search_knowledge", "get_template", "run_tool", "get_memory", "save_memory", "forget_memory", "submit_deliverable"])
      assert(tools.includes(t), `missing tool ${t}`);
    note(tools.join(", "));
  });
  await r.step("list_my_solvers answers for a new wallet", async () => {
    const text = await call(token, "list_my_solvers");
    assert(text.length > 0, "empty answer");
    return text.split("\n")[0];
  });
  await r.step(`find_solver suggests ${SLUG} for a matching need`, async () => {
    const found = await call(token, "find_solver", { need: NEED });
    assert(found.includes(`agent_id: ${agentId}`), `find_solver did not suggest ${SLUG}:\n${found.slice(0, 600)}`);
  });
  async function trialChecks(t: NonNullable<typeof trial>): Promise<string> {
    const sessionId = (await r.step("activate_solver opens a free-trial session and states its limits", async () => {
      const act = await call(token, "activate_solver", { agent_id: agentId });
      const sid = sessionIdOf(act);
      assert(sid, `no session_id:\n${act.slice(0, 400)}`);
      assert(new RegExp(`Free trial \\(use 1 of ${t.uses}\\)`).test(act), `no trial line:\n${act.slice(0, 600)}`);
      assert(act.includes("Tell the user about these limits"), "no instruction to tell the limits");
      return sid;
    }))!;
    await r.step("preflight_check passes", async () => {
      const pre = await call(token, "preflight_check", { session_id: sessionId, available_tools: ["solvers:next_step", "web_search"] });
      assert(pre.startsWith("All set"), `preflight:\n${pre.slice(0, 400)}`);
    });
    await r.step(`next_step delivers the ${t.steps} trial steps in order`, async () => {
      for (let i = 1; i <= t.steps; i++) {
        const st = await call(token, "next_step", { session_id: sessionId, completed_step: i - 1, result_summary: i > 1 ? `Summary of step ${i - 1}.` : undefined });
        assert(st.includes(`# Step ${i} of ${t.totalSteps}`), `expected step ${i}:\n${st.slice(0, 300)}`);
      }
    });
    if (t.steps < t.totalSteps) {
      await r.step("a step beyond the trial answers with the end-of-trial text and the purchase link (twice, no advance)", async () => {
        for (let k = 0; k < 2; k++) {
          const locked = await call(token, "next_step", { session_id: sessionId, completed_step: t.steps, result_summary: "Summary." });
          assert(locked.startsWith("The free trial of") && locked.includes("/checkout?agent="), `expected the end of the trial:\n${locked.slice(0, 400)}`);
        }
      });
    }
    if (t.searches > 0) {
      await r.step("search_knowledge answers inside the trial", async (note) => {
        const kb = await call(token, "search_knowledge", { session_id: sessionId, query: "how to associate error messages with the field" });
        assert(!/free trial/i.test(kb.slice(0, 80)) && kb.length > 80, `knowledge answer:\n${kb.slice(0, 300)}`);
        note(`${kb.length} characters`);
      });
    }
    const a11y = t.tools.find((x) => x.name === "a11y_check");
    if (a11y) {
      await r.step(`run_tool a11y_check: ${a11y.limit} runs inside the trial, then the end-of-trial text`, async (note) => {
        const input = { files: { "Bad.tsx": '<div onClick={x}><img src="a.png"/><input id="e"/></div>' } };
        let issues = 0;
        for (let i = 0; i < a11y.limit; i++) {
          const out = await call(token, "run_tool", { session_id: sessionId, tool: "a11y_check", input });
          if (i === 0) issues = (JSON.parse(out) as { issues: unknown[] }).issues.length;
        }
        assert(issues > 0, "a11y_check found no issue in a broken component");
        const over = await call(token, "run_tool", { session_id: sessionId, tool: "a11y_check", input });
        assert(/The free trial of/.test(over), `beyond the limit:\n${over.slice(0, 300)}`);
        note(`${issues} issues found on the first run`);
      });
    }
    return sessionId;
  }

  // Without a free trial only the trial checks are skipped: memory, the other-wallet refusal, the refresh-token rotation
  // and the invalid token still run, on a session of the free platform Solver Creator.
  let sessionId: string;
  let memoryAgentId: string;
  if (trial) {
    sessionId = await trialChecks(trial);
    memoryAgentId = agentId;
  } else {
    r.skip("free-trial checks", `${SLUG} has no free trial`);
    sessionId = (await r.step("no trial: a session on the free platform Solver Creator for the session checks", async () => {
      const act = await call(token, "activate_solver", { agent_id: CREATOR_SOLVER_ID });
      const sid = sessionIdOf(act);
      assert(sid, `no session_id from the Solver Creator:\n${act.slice(0, 400)}`);
      return sid;
    }))!;
    memoryAgentId = CREATOR_SOLVER_ID;
  }

  await r.step("memory: save_memory then get_memory (encrypted with the wallet's key)", async () => {
    await call(token, "save_memory", { agent_id: memoryAgentId, content: "Prefers strict TypeScript and Vitest." });
    const mem = await call(token, "get_memory", { agent_id: memoryAgentId });
    assert(mem.includes("strict TypeScript"), `memory:\n${mem.slice(0, 300)}`);
  });
  await r.step("another wallet cannot drive this session", async () => {
    const other = await connectOAuth(freshAccount(), { memory: false });
    let err: Error | undefined;
    try {
      await call(other.accessToken, "next_step", { session_id: sessionId });
    } catch (e) {
      err = e as Error;
    }
    assert(err && /another wallet/i.test(err.message), `expected a refusal, got ${err?.message ?? "success"}`);
  });
  await r.step("refresh token rotates (old one refused)", async () => {
    const refresh = (rt: string) =>
      fetch(`${API_URL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: oauth.clientId }),
      }).then(async (res) => ({ status: res.status, body: (await res.json()) as { access_token?: string } }));
    const first = await refresh(oauth.refreshToken);
    assert(first.status === 200 && first.body.access_token, `refresh: ${first.status} ${JSON.stringify(first.body)}`);
    const again = await refresh(oauth.refreshToken);
    assertEq(again.status, 400, "reusing the old refresh token");
    assert((await call(first.body.access_token!, "list_my_solvers")).length > 0, "new token does not work");
  });
  await r.step("invalid token -> 401", async () => {
    const res = await fetch(`${API_URL}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer invalid" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEq(res.status, 401, "status");
  });
});
