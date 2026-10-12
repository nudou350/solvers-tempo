// Smoke test of the paid Solvers on a running server WITHOUT spending anything: for each listed Solver that has a free
// trial, a fresh wallet connects through the person OAuth flow (only people get the trial), activates the Solver and
// checks that the knowledge base answers (the package version on disk must have its chunks in the database).
//
//   API_URL=https://... npx tsx src/smoke-catalog.ts [slug ...]      # default: every listed Solver with a trial (test Solvers excluded)
import { API_URL, freshAccount } from "./env.js";
import { get } from "./lib/http.js";
import { call, connectOAuth, initialize, sessionIdOf } from "./lib/mcp.js";
import { assert, run } from "./lib/report.js";

const QUERIES: Record<string, string> = {
  "copy-marketing": "character limit of a responsive search ad",
  "financas-pessoais": "how to prioritize debts",
  "frontend-react": "focus and accessibility in a modal",
  "planejador-viagens": "documents for a trip to Europe",
  "revisao-contratos": "penalty for early termination of a lease",
  "ui-design": "minimum WCAG contrast",
};

/** Test Solvers published by the e2e scripts (publish-test-agent, e2e-creator): skipped unless named. */
const TEST_SLUG = /^(e2e|qa)-/;

type Row = { id: string; slug: string; version: string; trialAvailable: boolean; platform: boolean };

await run(`smoke-catalog (${API_URL})`, async (r) => {
  const wanted = process.argv.slice(2);
  const all = await get<Row[]>("/api/agents");
  const rows = wanted.length ? wanted.map((s) => all.find((a) => a.slug === s) ?? ({ slug: s } as Row)) : all.filter((a) => a.trialAvailable && !a.platform && !TEST_SLUG.test(a.slug));
  if (rows.length === 0) {
    r.skip("catalog", "no listed Solver with a free trial");
    return;
  }
  for (const a of rows) {
    await r.step(
      `${a.slug}${a.version ? ` v${a.version}` : ""}: activates on the free trial and the knowledge base answers`,
      async (note) => {
        assert(a.id, `${a.slug} is not in the catalog`);
        const { accessToken } = await connectOAuth(freshAccount(), { memory: false });
        await initialize(accessToken, "smoke");
        const act = await call(accessToken, "activate_solver", { agent_id: a.id });
        const sid = sessionIdOf(act);
        assert(sid && /Free trial/.test(act), `activate:\n${act.slice(0, 200)}`);
        const kb = await call(accessToken, "search_knowledge", { session_id: sid, query: QUERIES[a.slug] ?? "best practices" });
        assert(kb.length > 120 && !/nothing relevant/i.test(kb.slice(0, 200)), `knowledge:\n${kb.slice(0, 200)}`);
        note(`${kb.length} characters`);
      },
      { critical: false },
    );
  }
});
