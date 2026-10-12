// Demo seed: fills the store with real on-chain data (local chain or Moderato; refused on mainnet).
// Prerequisites: contracts deployed (deployments/<CHAIN_ID>.json) and the Solvers published (cli:publish).
//
//   pnpm --filter @solvers/server cli:seed
//
// Creates test buyers (.keys/buyers/<name>.key, funded from the PLATFORM float), license purchases, reviews, verified
// uses (usage batches), one finished guarantee and one in progress. Every buyer transaction is signed by the buyer key and
// sponsored by RELAY, exactly like the web app; nothing chain-related is invented in the database (the indexer mirrors).
// Idempotent: purchase ids are deterministic (`seed:<buyer>:<agent>`), so a second run skips what already happened.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  createEscrowCalls,
  loadAccount,
  parseSolversEvents,
  purchaseLicenseCalls,
  recordUsageBatchCalls,
  releaseMilestoneCalls,
  submitReviewCalls,
} from "@solvers/chain";
import { solversEscrowAbi, solversRegistryAbi, solversReviewsAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, numberToUnits, purchaseIdFor } from "@solvers/shared";
import { encodeFunctionData, erc20Abi, type Account, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainContext, initChain } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { CHAIN, env } from "../env.js";
import { db, pool, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { sha256 } from "../lib/crypto.js";
import { getPackage } from "../runtime/packages.js";
import { findAgentRow, guaranteeOffer } from "../store/catalog.js";
import { reviewContentHash } from "../store/review-rules.js";
import { criteriaHash, readDeliverable, saveAcceptance, submitDeliverable } from "../verifier/deliverables.js";
import { indexTx, sendAsWallet } from "./wallet-send.js";

const KEYS = join(process.cwd(), ".keys", "buyers");
const BUYERS = ["ana", "bruno", "carla", "diego", "elisa", "fabio", "gabi", "novato"];
const units = (n: number) => numberToUnits(n, env.PAYMENT_TOKEN_DECIMALS);

function buyer(name: string): Account {
  const file = join(KEYS, `${name}.key`);
  if (existsSync(file)) return loadAccount(file, `buyer key ${name}`);
  mkdirSync(KEYS, { recursive: true });
  writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  return privateKeyToAccount(readFileSync(file, "utf8").trim() as Hex);
}

/** Tops up a buyer from the PLATFORM float (test networks only). */
async function fund(to: Account, amount: bigint) {
  const c = chainContext();
  const balance = await c.publicClient.readContract({ address: c.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [to.address] });
  if (balance >= amount) return;
  await sendServerCalls({
    signer: "platform",
    lane: "platform",
    calls: [{ to: c.deployment.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to.address, amount - balance] }) }],
    kind: "seed-fund",
    ref: to.address.toLowerCase(),
  });
}

const REVIEWS: Record<string, Array<[number, string]>> = {
  Development: [
    [5, "It produced a component with real tests and accessibility. Saved me a whole afternoon."],
    [5, "The review checklist caught two focus bugs I would have missed."],
    [4, "Very good. Sometimes it asks too much before starting, but the result pays off."],
    [5, "Finally the AI writes tests that test behaviour, not implementation."],
    [4, "Great for people who know the basics and want senior-level standards."],
  ],
  Design: [
    [5, "The contrast and spacing audit of my Figma file was spot on."],
    [4, "It helped me organise the tokens. I had to connect Figma first; the walkthrough helped."],
    [5, "The visual hierarchy of my landing page improved a lot with the suggestions."],
  ],
  Everyday: [
    [5, "Planned my trip to Portugal remembering I hate waking up early. Amazing."],
    [5, "The budget per category gave me a real sense of how much to take."],
    [4, "Very useful. I liked that it tells me what to double-check on official sites."],
  ],
  Business: [
    [4, "It pointed out penalty clauses I had not read properly. It is clear it does not replace a lawyer."],
    [5, "Turned my messy spreadsheet into a simple dashboard."],
  ],
  Writing: [
    [5, "The ads sound like my brand, without that generic text."],
    [4, "Good title variations to test."],
  ],
};

/** License of `buyer` for `agentId` bought by the seed (purchaseRef of its deterministic purchase id), or null. */
async function seededLicense(b: Account, agentId: Hex, purchaseId: Hex): Promise<bigint | null> {
  const c = chainContext();
  const ref = await c.publicClient.readContract({ address: c.deployment.registry, abi: solversRegistryAbi, functionName: "purchaseRef", args: [b.address, purchaseId] });
  const n = BigInt(ref);
  return n === 0n ? null : n & ((1n << 248n) - 1n);
}

async function main() {
  if (env.CHAIN_ID === CHAIN.mainnet) throw new Error("cli:seed creates test data: never on mainnet");
  await runMigrations();
  await initChain();
  const c = chainContext();
  const d = c.deployment;
  const agents = await db.select().from(schema.agents).where(and(eq(schema.agents.listed, true), eq(schema.agents.status, "active"), sql`${schema.agents.price} > 0`));
  if (agents.length === 0) throw new Error("no Solver published on-chain; run cli:publish first");
  console.log(`${agents.length} published Solvers`);

  const buyers: Record<string, Account> = {};
  for (const n of BUYERS) {
    buyers[n] = buyer(n);
    await fund(buyers[n]!, units(n === "novato" ? 30 : 300));
  }
  console.log("buyers funded with test stablecoins:", BUYERS.join(", "));

  // Purchases and reviews: each Solver gets 2 to 6 buyers ("novato" buys nothing).
  const veterans = BUYERS.filter((b) => b !== "novato");
  for (const [i, a] of agents.entries()) {
    const count = 2 + ((i * 3) % 5);
    const pool = REVIEWS[a.category] ?? REVIEWS.Development!;
    const id = agentIdToBytes32(a.id);
    for (let k = 0; k < count; k++) {
      const name = veterans[(i + k) % veterans.length]!;
      const b = buyers[name]!;
      const purchaseId = purchaseIdFor(`seed:${name}:${a.id}`);
      let tokenId = await seededLicense(b, id, purchaseId);
      if (tokenId === null) {
        await sendAsWallet(b, purchaseLicenseCalls(d, { agentId: id, price: a.price, purchaseId }));
        tokenId = await seededLicense(b, id, purchaseId);
      }
      const review = await c.publicClient.readContract({ address: d.reviews, abi: solversReviewsAbi, functionName: "reviewOf", args: [id, b.address] });
      if (review.rating === 0 && k < 4 && tokenId !== null) {
        const [rating, text] = pool[(i + k) % pool.length]!;
        const contentHash = reviewContentHash(text);
        // The text lives off-chain as a draft; the indexer turns it into the review when it sees the same hash on-chain.
        await db
          .insert(schema.reviewDrafts)
          .values({ agentId: a.id, authorWallet: b.address.toLowerCase(), contentHash, rating, text })
          .onConflictDoNothing();
        await sendAsWallet(b, submitReviewCalls(d, { agentId: id, tokenId, rating, contentHash }));
      }
    }
    console.log(`  ${a.name}: ${count} purchases`);
  }

  // Verified uses (on-chain batch, USAGE_ROLE on the usage lane) + 14 days of history for the weekly trend.
  for (const [i, a] of agents.entries()) {
    const base = 40 + ((i * 97) % 600);
    const previous = Math.round(base / 2);
    const recent = Math.round(previous * (0.75 + ((i * 3) % 7) / 10));
    const [already] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.usageEvents).where(eq(schema.usageEvents.agentId, a.id));
    if ((already?.n ?? 0) >= 20) continue;
    const rows = [];
    for (let day = 0; day < 14; day++) {
      const perDay = Math.max(1, Math.round((day < 7 ? recent : previous) / 7 / 3));
      for (let k = 0; k < perDay; k++) {
        rows.push({
          wallet: buyers[veterans[k % veterans.length]!]!.address.toLowerCase(),
          agentId: a.id,
          sessionId: null,
          tool: "activate_solver",
          responseHash: sha256(`${a.id}:${day}:${k}`).toString("hex"),
          batched: true,
          createdAt: new Date(Date.now() - day * 86400_000 - k * 3600_000),
        });
      }
    }
    await db.insert(schema.usageEvents).values(rows);
    const root = `0x${sha256(rows.map((r) => r.responseHash).join("")).toString("hex")}` as Hex;
    const r = await sendServerCalls({
      signer: "platform",
      lane: "usage",
      calls: recordUsageBatchCalls(d, { agentId: agentIdToBytes32(a.id), count: BigInt(base), merkleRoot: root }),
      kind: "usage-batch",
      ref: `seed:${a.id}`,
    });
    await indexTx(r.hash);
  }
  console.log("  verified uses recorded on-chain");

  // Guarantees with the front-end Solver: one finished and one in progress.
  const fe = agents.find((a) => a.guaranteeAvailable);
  const example = getPackage("frontend-react");
  if (fe && example) {
    const b = buyers.ana!;
    const existing = await db.select().from(schema.escrows).where(eq(schema.escrows.buyerWallet, b.address.toLowerCase()));
    if (existing.length === 0) {
      const files = readDeliverable(join(example.dir, "verifier", "example"));
      // The agreed acceptance suite is the example's test; the delivery carries the component and its own tests.
      const acceptanceTests = Object.fromEntries(Object.entries(files).filter(([n]) => n.endsWith(".test.tsx")));
      for (const [n, done] of [
        [1, true],
        [2, false],
      ] as const) {
        const offer = guaranteeOffer(await findAgentRow(fe.id), 1);
        if (!offer) throw new Error("frontend-react has no guarantee template (for the demo, use GUARANTEE_MIN_SALES=0)");
        const ms = offer.milestones.map((m) => ({ title: m.title, criteria: m.criteria.join("\n"), amount: units(m.amountUsdc), verify: m.verify }));
        const testIdx = ms.length - 1;
        const task =
          n === 1
            ? { title: "Accessible login form", description: "E-mail and password login, validation on submit and errors announced to screen readers." }
            : { title: "Password recovery screen", description: "E-mail field, sending confirmation and accessible error messages." };
        const purchaseId = purchaseIdFor(`seed:escrow:${b.address.toLowerCase()}:${n}`);
        // Acceptance suite saved under the purchase id (the escrow id only exists once the purchase is mined).
        const acc = saveAcceptance(purchaseId, testIdx, acceptanceTests);
        const hashes = ms.map((m, idx) => criteriaHash(m.title, m.criteria, idx === testIdx ? acc.hash : null).toString("hex"));
        const { receipt } = await sendAsWallet(
          b,
          createEscrowCalls(d, {
            agentId: agentIdToBytes32(fe.id),
            milestones: ms.map((m, idx) => ({ amount: m.amount, criteriaHash: `0x${hashes[idx]}` as Hex })),
            reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
            deliveryDays: 0,
            purchaseId,
          }),
        );
        const created = parseSolversEvents(receipt.logs, d).find((e) => e.eventName === "EscrowCreated");
        if (!created) throw new Error("EscrowCreated not found in the receipt");
        const escrowId = String((created.args as { escrowId: bigint }).escrowId);
        const [, , creator, total, feeBps, reviewWindowSecs, deliveryDeadline] = await c.publicClient.readContract({
          address: d.escrow,
          abi: solversEscrowAbi,
          functionName: "escrowOf",
          args: [BigInt(escrowId)],
        });
        // Off-chain texts of the task (the chain only has hashes); chain fields come from escrowOf.
        await db
          .insert(schema.escrows)
          .values({
            id: escrowId,
            agentId: fe.id,
            buyerWallet: b.address.toLowerCase(),
            creatorWallet: creator.toLowerCase(),
            ...task,
            purchaseId,
            total,
            reviewWindowSecs,
            deliveryDeadline: new Date(Number(deliveryDeadline) * 1000),
            feeBps,
            txHash: receipt.transactionHash,
          })
          .onConflictDoUpdate({ target: schema.escrows.id, set: task });
        for (const [idx, m] of ms.entries()) {
          const off = {
            title: m.title,
            criteria: m.criteria,
            verify: m.verify,
            acceptancePath: idx === testIdx ? acc.path : null,
            acceptanceHash: idx === testIdx ? acc.hash : null,
          };
          await db
            .insert(schema.milestones)
            .values({ escrowId, idx, criteriaHash: hashes[idx]!, amount: m.amount, ...off })
            .onConflictDoUpdate({ target: [schema.milestones.escrowId, schema.milestones.idx], set: off });
        }
        await submitDeliverable({ wallet: b.address, agentId: fe.id, escrowId, index: testIdx, files });
        if (done) {
          for (let idx = 0; idx < ms.length; idx++) await sendAsWallet(b, releaseMilestoneCalls(d, { escrowId: BigInt(escrowId), index: idx }));
        }
        console.log(`  guarantee ${done ? "finished" : "in progress"}: ${escrowId}`);
      }
    }
  }
  console.log("\nSeed finished.");
}

if (/cli[\\/]seed\.(ts|js)$/.test(process.argv[1] ?? "")) {
  try {
    await main();
  } finally {
    await pool.end();
  }
  process.exit(0);
}
