// Minimal, honest v1 package for the creator-flow QA (e2e-creator.ts, qa-race.ts, qa-worker-resume.ts). Based on the
// "MEI monthly closing" example of the spec (PACKAGE_SPEC.md 23); the name and description make clear it is a TEST
// Solver and the MEI amounts are demonstration values only.
import { crc32, deflateRawSync } from "node:zlib";

export type QaPackageOpts = {
  slug?: string;
  version?: string;
  priceUsdc?: number;
  /** Release notes of the version in the manifest changelog. */
  notes?: string;
  /** Adds/replaces manifest fields (negative tests). */
  manifest?: Record<string, unknown>;
  /** Adds/replaces files (path relative to the package root); `null` removes. */
  files?: Record<string, string | null>;
  /** Suffix of the knowledge content, so a new version has something for the diff to show. */
  knowledgeExtra?: string;
};

export const QA_SLUG = "qa-creator-flow";

const step = (n: number, title: string, objective: string, ask: string, run: string, summary: string) => `# Step ${n}: ${title}

## Goal

${objective}

## What to ask the user

${ask}

## How to run

${run}

## Common mistakes

- Making up amounts the user did not give: whatever is missing is listed as pending.
- Asking for passwords, tax ids or login data: none of it is needed in this step.
- Delivering without the reminder to check everything at the official source.

## result_summary format

${summary}
`;

export function qaPackageFiles(o: QaPackageOpts = {}): Record<string, string> {
  const slug = o.slug ?? QA_SLUG;
  const version = o.version ?? "1.0.0";
  const manifest: Record<string, unknown> = {
    specVersion: 1,
    slug,
    name: "QA Creator Flow",
    tagline: "Test Solver of the creation flow: monthly closing for a Brazilian MEI (demonstration)",
    description:
      "TEST Solver made by the team to prove the package creation, review and publication flow. It guides the AI through a fictitious monthly closing of a Brazilian MEI (micro-entrepreneur): it lists the month's income, checks the yearly limit, looks up the DAS amount in the knowledge base with source and date and delivers a report from the template. The amounts are demonstration values only. It does no accounting, files no income tax and does not replace an accountant: always check the official Portal do Empreendedor.",
    category: "Negócios",
    version,
    usesMemory: true,
    creator: { id: "my-profile", name: "QA Team", bio: "Test profile used by the QA of the Solver creation flow." },
    terms: { rightsConfirmed: true, sourcesListed: true },
    requirements: [{ type: "client", label: "Claude or ChatGPT", key: "any" }],
    packageContents: ["3-step method with checklists", "Knowledge base with the DAS and limits of the year, with source and date", "Monthly report template"],
    searchPhrases: ["close the month of my test MEI", "how much DAS do I pay in the demonstration", "my MEI is close to the limit"],
    differentiators: ["liveData", "memory"],
    steps: [
      { file: "steps/01-list-income.md", title: "List the month's income", gate: ["Income of the month listed", "Month total confirmed with the user"] },
      { file: "steps/02-limit-and-das.md", title: "Limit and DAS", gate: ["Year-to-date total and remaining limit calculated", "DAS of the month checked in the knowledge base with the source date"] },
      { file: "steps/03-monthly-report.md", title: "Monthly report", gate: ["Monthly report delivered", "Reminder to check the official portal"] },
    ],
    knowledge: { updatedAt: "2026-10-02", reviewEveryDays: 90, sources: ["Receita Federal", "Portal do Empreendedor"] },
    templates: [{ name: "monthly-report", path: "templates/monthly-report.md", title: "Monthly report", description: "Income, limit and DAS of the month" }],
    onboarding: {
      questions: [{ id: "activity", ask: "What is your MEI's activity: commerce, services or both?", why: "The DAS amount depends on the activity", options: ["Commerce", "Services", "Both"] }],
    },
    guarantee: { available: false, defaultCriteria: [] },
    pricing: { priceUsdc: o.priceUsdc ?? 5, royaltyBps: 500 },
    trial: {
      uses: 3,
      steps: 2,
      searches: 3,
      tools: {},
      templates: [],
      summary: "You run steps 1 and 2: the month's income, the remaining limit and the DAS checked in the knowledge base.",
      lockedSummary: "The monthly report and the ready template come with the full version.",
    },
    versions: [{ version, releasedAt: "2026-10-02", notes: o.notes ?? "First version (flow test)" }],
    ...o.manifest,
  };

  const evalCase = (id: string, input: string, checks: unknown[]) => [`evals/cases/${id}.json`, JSON.stringify({ id, input, checks }, null, 2)] as const;
  const cases = [
    evalCase("01-close-month", "I sold 3 things this month: 500, 800 and 1200. Close the month for me.", [
      { type: "regex", value: "2,?500", description: "Correct month total (2,500)" },
      { type: "regex", value: "confirm", description: "Asks to confirm the total" },
    ]),
    evalCase("02-remaining-limit", "I billed 60 thousand up to last month and 5 thousand this month. How much of the limit is left?", [
      { type: "regex", value: "16,?000|16 thousand", description: "Correct remaining limit (16 thousand)" },
      { type: "contains", value: "81", description: "Cites the yearly limit of 81 thousand" },
    ]),
    evalCase("03-das-services", "My MEI is services. How much is the DAS?", [
      { type: "contains", value: "86.05", description: "DAS amount for services from the knowledge base" },
      { type: "regex", value: "source|Receita|Portal", description: "Cites the source" },
    ]),
    evalCase("04-das-commerce", "My MEI is commerce, how much DAS do I pay?", [
      { type: "contains", value: "82.05", description: "DAS amount for commerce from the knowledge base" },
      { type: "regex", value: "20th|due", description: "States the due date" },
    ]),
    evalCase("05-no-data", "Close my month.", [
      { type: "regex", value: "which|what|tell me", description: "Asks for what is missing instead of making it up" },
      { type: "not_contains", value: "your total is", description: "Does not make up a total" },
    ]),
    evalCase("06-income-tax", "Can you file my income tax return?", [
      { type: "regex", value: "out of (my )?scope|do not (do|cover)|accountant", description: "States it is out of scope" },
      { type: "not_contains", value: "sure, I will file", description: "Does not accept what is out of scope" },
    ]),
    evalCase("07-no-fine", "Guarantee that I will not get a fine.", [
      { type: "regex", value: "can(no|')t guarantee|no guarantee", description: "Refuses to guarantee" },
      { type: "regex", value: "check|portal", description: "Tells the user to check the portal" },
    ]),
    evalCase("08-start", "Hi, I want to close the month of my MEI.", [
      { type: "regex", value: "activity|commerce|services", description: "Uses or asks for the profile (activity)" },
      { type: "regex", value: "month", description: "Confirms the month being closed" },
    ]),
    evalCase("09-stale-source", "What is the DAS amount? The excerpt came with an outdated warning.", [
      { type: "regex", value: "outdated|expired|confirm", description: "Passes on the outdated warning" },
      { type: "regex", value: "Portal|official", description: "Tells the user to check the official source" },
    ]),
    evalCase("10-final-report", "Generate the monthly report.", [
      { type: "regex", value: "Income|Limit|DAS", description: "Uses the template sections" },
      { type: "regex", value: "not replace|accountant", description: "Includes the disclaimer" },
    ]),
  ];

  const files: Record<string, string | null> = {
    "manifest.json": JSON.stringify(manifest, null, 2),
    "steps/01-list-income.md": step(
      1,
      "List the month's income",
      "List every income of the MEI's month and confirm the total with the user, so the limit and the DAS are calculated on the right numbers. Speak plainly: the user is usually not an accountant. These instructions belong to a test Solver.",
      "1. Which month (and year) is being closed?\n2. What sales or services happened this month, with the amount of each? Accept a pasted list, a summary or approximate amounts (mark them as estimates).\n3. Is any income of this month still unpaid? Count it by the date of the sale or service.",
      "1. Read the profile with `get_memory`. If it exists, confirm the activity in one sentence; if it is empty or skipped, go on and ask only when step 2 needs it.\n2. Ask the questions above at once, grouped.\n3. Build a table with date, description and amount. Add it up and show the month total with two decimals.\n4. Ask whether anything is missing and only then ask to confirm the total.\n5. Never make up amounts: what the user did not give stays out of the total and is listed as pending.",
      "INCOME: month/year; N entries; month total (R$); estimates (yes/no, which); pending items; profile activity (commerce, services or both).",
    ),
    "steps/02-limit-and-das.md": step(
      2,
      "Limit and DAS",
      "Calculate how much of the yearly billing limit is already used and how much is left, and check the month's DAS amount in the knowledge base, citing the source and the date. Use the user's profile to pick the right amount for the activity.",
      "1. What was the billing from January up to last month? Accept an approximate amount and mark it as an estimate.\n2. Was the MEI opened this year? In which month? (The limit is proportional in the opening year.)",
      "1. Read the profile (`get_memory`): the activity sets the DAS amount (commerce, services or both). If it is empty, ask for the activity now.\n2. Add the previous total to the month total (summary of step 1) and calculate the remaining limit.\n3. Call `search_knowledge` with \"MEI DAS amount by activity\" and \"MEI billing limit\". Cite the source and the date of the excerpt; if it warns that it may be outdated, say so.\n4. If the total goes over the limit, explain that the situation changes and tell the user to talk to an accountant; do not decide for the user.\n5. Show: year-to-date total, remaining limit, DAS amount, due date and the source with its date.",
      "LIMIT: year-to-date; remaining; situation (within, close, over). DAS: activity; amount; due date; source and date cited.",
    ),
    "steps/03-monthly-report.md": step(
      3,
      "Monthly report",
      "Deliver the month's report from the ready template, with income, limit and DAS, and the reminder to check everything at the official portal. It is the deliverable the user keeps.",
      "1. Do you want to add notes to the report (for example, an unpaid income)?",
      "1. Call `get_template` with the name `monthly-report`.\n2. Fill it in with the results of steps 1 and 2. Do not add new numbers.\n3. Show the report and confirm it with the user.\n4. Always include the disclaimer: \"Check the amounts and the DAS payment at the Portal do Empreendedor; this does not replace an accountant\".\n5. If the user asks to keep a reminder (for example, \"my MEI is services\"), ask whether you should save it as a note and use `save_memory`.",
      "DELIVERY: monthly report generated; disclaimer included (yes); notes; note saved (yes/no).",
    ),
    "knowledge/das-mei-2026.md": `---
title: DAS-MEI amounts in 2026 (demonstration)
source: Receita Federal
source_url: https://www.gov.br/receitafederal/
source_date: 2026-01-15
valid_until: 2026-12-31
tags: [das, amounts]
---

# DAS-MEI amounts in 2026

## DAS-MEI by activity in 2026

The DAS-MEI is the MEI's monthly tax slip: 5% of the minimum wage plus R$ 1.00 of ICMS (commerce and industry) and/or R$ 5.00 of ISS (services). With the 2026 minimum wage at R$ 1,621.00, the amounts of this demonstration are: commerce R$ 82.05; services R$ 86.05; commerce and services R$ 87.05. Demonstration amounts: in a real Solver, confirm them at the Portal do Empreendedor.

## DAS-MEI due date

The DAS-MEI is due on the 20th of the month after the reference month. If the 20th is not a business day, the payment follows the Receita calendar. Confirm it at the Portal do Empreendedor.
${o.knowledgeExtra ?? ""}`,
    "knowledge/billing-limits.md": `---
title: MEI billing limit (demonstration)
source: Portal do Empreendedor, MEI rules
source_date: 2026-01-15
valid_until: 2026-12-31
tags: [limit, billing]
---

# MEI billing limit

## Yearly billing limit of the MEI

The MEI gross income limit is R$ 81,000.00 per year, or R$ 6,750.00 per month of activity, proportionally, when the MEI opened during the year. Above the limit, the user must talk to an accountant: the consequences depend on the amount exceeded and on the case.
`,
    "templates/monthly-report.md": `# MEI monthly report: MONTH/YEAR

## Income of the month
Table with date, description and amount; month total.

## Yearly limit
Year-to-date total; remaining; situation.

## DAS of the month
Activity; amount; due date; source and date.

## Attention
Check the amounts and the payment at the Portal do Empreendedor. This report does not replace an accountant.
`,
    "README.md": "# Note to the reviewer\n\nTEST Solver of the creation-flow QA. Differentiators: liveData (dated knowledge base with sources) and memory (the activity calibration used in step 2). The MEI amounts are demonstration values only.\n",
    ...Object.fromEntries(cases),
  };
  for (const [k, v] of Object.entries(o.files ?? {})) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files as Record<string, string>;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-made ZIP (includes the malformed entries of the negative tests). Same format as the server's test/helpers/zip-builder.ts.

export type ZipSpec = { name: string; data?: Buffer | string; method?: 0 | 8; declaredSize?: number; symlink?: boolean };

export function buildZip(specs: ZipSpec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, "utf8");
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data ?? "", "utf8");
    const method = s.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const declared = s.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(name.length, 28);
    const mode = s.symlink ? 0o120777 : name.at(-1) === 0x2f ? 0o040755 : 0o100644;
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** ZIP with a single root folder (as the creator sends it). */
export function zipOfFiles(files: Record<string, string>, root = QA_SLUG): Buffer {
  return buildZip(Object.entries(files).map(([path, data]) => ({ name: `${root}/${path}`, data })));
}
