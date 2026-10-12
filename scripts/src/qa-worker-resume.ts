// Worker QA (PACKAGE_SPEC.md 16): kills the worker IN THE MIDDLE of an ingestion and proves that, when it comes back, it
// resumes from the last finished file (ingest_jobs.files_done) without duplicating chunks. The script starts its own
// worker (with .env.qa set explicitly, SUBMISSIONS_INLINE=false), kills only that process (by its pid), starts another
// one and stops it at the end. It refuses to run while any other worker process is running (it would take the job and
// this script never kills processes it did not start). Prerequisites: the QA API WITHOUT inline processing and the QA
// creator already invited (run e2e-creator's stage 1 first).
//
//   cd apps/server && SUBMISSIONS_INLINE=false node --env-file=.env.qa --import tsx src/index.ts         # terminal 1
//   cd scripts && ONLY_STAGES=1 npx tsx src/e2e-creator.ts                                              # invites the creator (once)
//   cd scripts && npx tsx src/qa-worker-resume.ts
import "./lib/qa-defaults.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateKey } from "@solvers/chain";
import { privateKeyToAccount } from "viem/accounts";
import { API_URL, SERVER_DIR, sleep } from "./env.js";
import { ENV_QA, QA_DATA, qaChildEnv, requireLocalApi, sql } from "./lib/qa-env.js";
import { qaPackageFiles, zipOfFiles } from "./lib/qa-package.js";
import { assert, run } from "./lib/report.js";
import { TestWallet } from "./lib/wallet.js";

requireLocalApi(API_URL);

function workerPids(): number[] {
  if (process.platform === "win32") {
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src/worker/index.ts*' } | ForEach-Object { $_.ProcessId }"],
      { encoding: "utf8" },
    ).stdout;
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  return spawnSync("pgrep", ["-f", "src/worker/index.ts"], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean).map(Number);
}

/** Workers started by this script (the only processes it ever kills). */
const started: ChildProcess[] = [];
function startWorker(): ChildProcess {
  const child = spawn(process.execPath, [`--env-file=${ENV_QA}`, "--import", "tsx", "src/worker/index.ts"], {
    cwd: SERVER_DIR,
    env: qaChildEnv({ SUBMISSIONS_INLINE: "false" }),
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) throw new Error("the worker did not start");
  started.push(child);
  return child;
}
function stopStarted(): void {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
}
process.on("exit", stopStarted);

await run("qa-worker-resume (ingestion resumes from its checkpoint)", async (r) => {
  const keyFile = join(QA_DATA, "keys", "qa-creator.key");
  assert(existsSync(keyFile), `missing ${keyFile}: run e2e-creator (stage 1) first`);
  const others = workerPids();
  assert(others.length === 0, `other worker processes are running (pids ${others.join(", ")}): stop them first; this script only kills the worker it starts`);
  let worker = startWorker();
  await sleep(3000);
  assert(worker.exitCode === null, `the worker exited at start (code ${worker.exitCode})`);
  const creator = await new TestWallet(privateKeyToAccount(loadPrivateKey(keyFile, "qa-creator")), "creator").login();

  // A package with many knowledge files (2 sections = 2 chunks each) so the ingestion lasts a few seconds.
  const N = Number(process.env.FILES ?? 400);
  const files = qaPackageFiles({ slug: "qa-worker-resume" });
  for (let i = 0; i < N; i++) {
    files[`knowledge/batch/file-${String(i).padStart(4, "0")}.md`] =
      `---\ntitle: Note ${i} of the test batch\nsource: Portal do Empreendedor\nsource_date: 2026-01-15\nvalid_until: 2026-12-31\ntags: [batch]\n---\n\n# Note ${i}\n\n## First part ${i}\n\nUnique text ${i}-${Math.random().toString(36).slice(2)} about subject ${i * 7919} of the worker test batch.\n\n## Second part ${i}\n\nAnother text ${i}-${Math.random().toString(36).slice(2)} with explanation ${i * 104729} of the test batch.\n`;
  }
  const manifest = JSON.parse(files["manifest.json"]!);
  manifest.packageContents = [...manifest.packageContents, "Large batch of knowledge notes (worker test)"];
  files["manifest.json"] = JSON.stringify(manifest, null, 2);

  let id = "";
  await r.step(`upload a package with ${N} knowledge files`, async () => {
    const up = await fetch(`${API_URL}/api/creator/submissions`, { method: "POST", headers: { authorization: `Bearer ${creator.token}`, "content-type": "application/zip" }, body: zipOfFiles(files, "qa-worker-resume") as unknown as BodyInit });
    const body = (await up.json()) as { id?: string };
    assert(up.status === 202 && body.id, `upload failed: ${up.status} ${JSON.stringify(body)}`);
    id = body.id!;
    return id;
  });

  await r.step("kill the worker in the middle of the ingestion", async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const j = sql<{ status: string; files_done: number; files_total: number }>(`select status, files_done, files_total from ingest_jobs where submission_id = '${id}'`)[0];
      if (j && j.status === "running" && j.files_done >= 20 && j.files_done < j.files_total) {
        const pid = worker.pid;
        worker.kill("SIGKILL");
        return `killed the worker this script started (pid ${pid}) with ${j.files_done}/${j.files_total} files ingested`;
      }
      if (j?.status === "done") break;
      await sleep(150);
    }
    throw new Error("could not catch the ingestion in the middle (raise FILES)");
  });

  await r.step("restart the worker: it finishes from the checkpoint with no duplicated chunks", async () => {
    await sleep(1500);
    worker = startWorker();
    let final: any;
    const t1 = Date.now();
    while (Date.now() - t1 < 240_000) {
      final = sql(
        `select s.status, j.status ingest, j.files_done, j.files_total, j.chunks_done, (select count(*)::int from knowledge_chunks k where k.agent_id = s.agent_id) chunks, (select count(*)::int from (select source, content from knowledge_chunks k where k.agent_id = s.agent_id group by source, content having count(*) > 1) d) duplicates from package_submissions s join ingest_jobs j on j.submission_id = s.id where s.id = '${id}'`,
      )[0];
      if (final?.status === "pending_review" || final?.status === "rejected_validation") break;
      await sleep(1000);
    }
    assert(final?.status === "pending_review" && final.ingest === "done" && final.files_done === final.files_total && final.duplicates === 0 && final.chunks === final.chunks_done, JSON.stringify(final));
    return JSON.stringify(final);
  });
});
