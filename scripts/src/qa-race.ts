// Race QA of the creation flow (PACKAGE_SPEC.md 14): (a) simultaneous uploads do not break the per-creator limit of
// open submissions; (b) simultaneous reviewer decisions on the SAME submission: only one counts.
// Prerequisite: the local QA environment after e2e-creator (its creator key in apps/server/.qa-data/keys/qa-creator.key).
//   cd scripts && npx tsx src/qa-race.ts
import "./lib/qa-defaults.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateKey } from "@solvers/chain";
import { privateKeyToAccount } from "viem/accounts";
import { API_URL, sleep } from "./env.js";
import { QA_DATA, qaAdmin, requireLocalApi, sql } from "./lib/qa-env.js";
import { qaPackageFiles, zipOfFiles } from "./lib/qa-package.js";
import { assert, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

requireLocalApi(API_URL);
const CHECKLIST = { promiseDelivered: true, twoDifferentiatorsProven: true, rightsAndSources: true, noHarmfulInstructions: true, priceTrialShowcaseCoherent: true };
const OPEN = "'submitted','validating','pending_review','changes_requested','awaiting_creator_signature','awaiting_onchain_approval','publishing','publish_failed'";

await run("qa-race (submission limit and single reviewer decision)", async (r) => {
  const keyFile = join(QA_DATA, "keys", "qa-creator.key");
  assert(existsSync(keyFile), `missing ${keyFile}: run e2e-creator (stage 1) first`);
  const creator = await new TestWallet(privateKeyToAccount(loadPrivateKey(keyFile, "qa-creator")), "creator").login();
  const admin = await new TestWallet(qaAdmin(), "admin").login();
  const open = () => sql<{ n: number }>(`select count(*)::int n from package_submissions where creator_wallet = '${creator.lower}' and status in (${OPEN})`)[0]!.n;
  const before = open();

  const slugs = ["qa-race-a", "qa-race-b", "qa-race-c", "qa-race-d", "qa-race-e", "qa-race-f"];
  let accepted: { slug: string; status: number; body: { id?: string; code?: string } }[] = [];
  await r.step(`6 simultaneous uploads keep the limit of 3 open submissions (open before: ${before})`, async () => {
    const results = await Promise.all(
      slugs.map(async (slug) => {
        const res = await fetch(`${API_URL}/api/creator/submissions`, { method: "POST", headers: { authorization: `Bearer ${creator.token}`, "content-type": "application/zip" }, body: zipOfFiles(qaPackageFiles({ slug }), slug) as unknown as BodyInit });
        return { slug, status: res.status, body: (await res.json().catch(() => ({}))) as { id?: string; code?: string } };
      }),
    );
    accepted = results.filter((x) => x.status === 202);
    const others = results.filter((x) => ![202, 429].includes(x.status));
    assert(others.length === 0, `unexpected statuses: ${JSON.stringify(others)}`);
    assert(before + accepted.length <= 3, `limit broken: ${before} + ${accepted.length} > 3`);
    return `${accepted.length} accepted (202), ${results.length - accepted.length} refused (429)`;
  }, { critical: false });

  const target = accepted[0]?.body.id;
  if (!target) r.skip("simultaneous decisions on one submission", "no upload was accepted (the creator already has 3 open submissions)");
  else {
    await r.step("4 simultaneous decisions (3 approve + 1 request changes): exactly one wins and one trail row", async () => {
      for (let i = 0; i < 120; i++) {
        if (sql<{ status: string }>(`select status from package_submissions where id = '${target}'`)[0]?.status === "pending_review") break;
        await sleep(1000);
      }
      const decide = (action: string) =>
        fetch(`${API_URL}/api/admin/submissions/${target}/${action}`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" }, body: JSON.stringify({ notes: `race: ${action}`, checklist: CHECKLIST }) }).then((x) => ({ action, status: x.status }));
      const out = await Promise.all([decide("approve"), decide("approve"), decide("approve"), decide("request-changes")]);
      const rows = sql<{ action: string }>(`select action from package_reviews where submission_id = '${target}'`);
      assert(out.filter((o) => o.status === 200).length === 1 && rows.length === 1, `answers ${JSON.stringify(out)}; trail ${JSON.stringify(rows)}`);
      return `winner: ${out.find((o) => o.status === 200)?.action}`;
    }, { critical: false });
  }

  // Cleanup: reject what was left open so the creator is not stuck (the decided target included).
  for (const a of accepted) {
    for (let i = 0; i < 60; i++) {
      const s = sql<{ status: string }>(`select status from package_submissions where id = '${a.body.id}'`)[0]?.status;
      if (s && !["submitted", "validating"].includes(s)) break;
      await sleep(1000);
    }
    // An approved submission (awaiting the creator's signature) is revoked first (back to changes_requested), then rejected.
    for (const action of ["revoke", "reject"]) {
      await fetch(`${API_URL}/api/admin/submissions/${a.body.id}/${action}`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" }, body: JSON.stringify({ notes: "race test cleanup", checklist: {} }) });
    }
  }
});
