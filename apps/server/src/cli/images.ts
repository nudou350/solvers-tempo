// Specialists' image gallery and moderation of review photos (done by the admin: the creator never changes an image
// without review; whoever reviews the package reviews the screenshots and uploads them here).
//
//   pnpm --filter @solvers/server cli:images list <slug>                      gallery + review photos, with ids and URLs
//   pnpm --filter @solvers/server cli:images add <slug> <file...>             adds to the gallery (max. 5, in file order)
//   pnpm --filter @solvers/server cli:images remove <slug> <id>               removes an image from the gallery
//   pnpm --filter @solvers/server cli:images remove-review <id>               removes a review photo (moderation)
//   pnpm --filter @solvers/server cli:images seed [slug] [--force]            demo: cards generated from the package (cover, method, before/after, contents);
//                                                                             skips those with a gallery (--force replaces the whole gallery)
//   pnpm --filter @solvers/server cli:images preview <folder> [slug]          only writes the seed PNGs to a folder (no database or CDN)
//
// The first image is the cover.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { MAX_AGENT_IMAGES } from "@solvers/shared";
import { db, pool, schema } from "../db/index.js";
import { ImageError, processImage } from "../images/process.js";
import { gallerySvgs, renderPng, type ArtInput } from "../images/seed-art.js";
import { imageStore, type ImageStore } from "../images/store.js";
import { packages, type SolverPackage } from "../runtime/packages.js";
import { findAgentRow } from "../store/catalog.js";
import { firstFreePosition } from "../store/image-rules.js";

const USAGE = "usage: cli:images list <slug> | add <slug> <file...> | remove <slug> <id> | remove-review <id> | seed [slug] [--force] | preview <folder> [slug]";

function store(): ImageStore {
  const s = imageStore();
  if (!s) throw new Error("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not set in .env");
  return s;
}

async function list(slug: string) {
  const s = store();
  const agent = await findAgentRow(slug);
  const rows = await db.select().from(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id)).orderBy(asc(schema.agentImages.position));
  console.log(`Gallery of ${agent.slug} (${rows.length}/${MAX_AGENT_IMAGES})`);
  for (const r of rows) console.log(`  #${r.position + 1}  ${r.id}  ${r.width}x${r.height}  ${s.url(r.key, "full")}`);
  const reviews = await db.select().from(schema.reviews).where(eq(schema.reviews.agentId, agent.id));
  for (const rv of reviews) {
    const imgs = await db.select().from(schema.reviewImages).where(eq(schema.reviewImages.reviewId, rv.id)).orderBy(asc(schema.reviewImages.position));
    for (const r of imgs) console.log(`  review by ${rv.authorWallet.slice(0, 6)}…  ${r.id}  ${s.url(r.key, "full")}`);
  }
}

async function add(slug: string, files: string[]) {
  if (files.length === 0) throw new Error(USAGE);
  const s = store();
  const agent = await findAgentRow(slug);
  for (const file of files) {
    const used = (await db.select({ position: schema.agentImages.position }).from(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id))).map((r) => r.position);
    const position = firstFreePosition(used, MAX_AGENT_IMAGES);
    if (position === null) throw new Error(`The gallery already has ${MAX_AGENT_IMAGES} images; remove one first (cli:images remove).`);
    const img = await processImage(await readFile(file));
    const key = `solvers/agents/${agent.id}/${randomBytes(12).toString("hex")}`;
    await s.put(key, img.data);
    try {
      await db.insert(schema.agentImages).values({ id: randomBytes(8).toString("hex"), agentId: agent.id, position, key, width: img.width, height: img.height });
    } catch (e) {
      await s.delete(key).catch(() => {});
      throw e;
    }
    console.log(`  #${position + 1}  ${file}  ->  ${s.url(key, "full")}`);
  }
}

async function remove(slug: string, id: string) {
  const s = store();
  const agent = await findAgentRow(slug);
  const rows = await db.select().from(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id));
  const img = rows.find((r) => r.id === id);
  if (!img) throw new Error(`image ${id} is not in the gallery of ${agent.slug} (see cli:images list)`);
  await db.delete(schema.agentImages).where(eq(schema.agentImages.id, id));
  await s.delete(img.key);
  console.log(`removed ${id}`);
}

async function removeReview(id: string) {
  const s = store();
  const [img] = await db.delete(schema.reviewImages).where(eq(schema.reviewImages.id, id)).returning();
  if (!img) throw new Error(`review photo ${id} not found`);
  await s.delete(img.key);
  console.log(`removed ${id}`);
}

function artInput(pkg: SolverPackage): ArtInput {
  const m = pkg.manifest;
  return {
    name: m.name,
    tagline: m.tagline,
    category: m.category,
    version: m.version,
    creatorName: m.creator.name,
    steps: pkg.steps.map((st) => ({ title: st.title, gate: st.gate })),
    beforeAfter: m.beforeAfter,
    packageContents: m.packageContents,
  };
}

function selected(slug?: string): SolverPackage[] {
  const all = [...new Map([...packages().values()].map((p) => [p.manifest.id, p])).values()]; // the map is keyed by id and by slug
  const list = slug ? all.filter((p) => p.manifest.slug === slug) : all;
  if (slug && list.length === 0) throw new Error(`package ${slug} not found in AGENTS_DIR`);
  return list;
}

async function preview(dir: string, slug?: string) {
  await mkdir(dir, { recursive: true });
  for (const pkg of selected(slug)) {
    for (const [i, art] of gallerySvgs(artInput(pkg)).entries()) {
      await writeFile(join(dir, `${pkg.manifest.slug}-${i + 1}-${art.name}.png`), await renderPng(art.svg));
    }
    console.log(`  ${pkg.manifest.slug}`);
  }
}

/** Demo gallery: one card per package topic, for every specialist in the database without images yet. */
async function seed(slug: string | undefined, force: boolean) {
  const s = store();
  for (const pkg of selected(slug)) {
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, pkg.manifest.id));
    if (!agent) {
      console.log(`  ${pkg.manifest.slug}: not in the database, skipped`);
      continue;
    }
    const current = await db.select().from(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id));
    if (current.length > 0 && !force) {
      console.log(`  ${agent.slug}: already has ${current.length} image(s), skipped (use --force to replace)`);
      continue;
    }
    // Render and upload everything BEFORE touching the current gallery: a failure midway never leaves the specialist without images.
    const fresh: { id: string; key: string; width: number; height: number }[] = [];
    try {
      for (const art of gallerySvgs(artInput(pkg)).slice(0, MAX_AGENT_IMAGES)) {
        const img = await processImage(await renderPng(art.svg));
        const key = `solvers/agents/${agent.id}/${randomBytes(12).toString("hex")}`;
        await s.put(key, img.data);
        fresh.push({ id: randomBytes(8).toString("hex"), key, width: img.width, height: img.height });
      }
      await db.transaction(async (tx) => {
        await tx.delete(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id));
        await tx.insert(schema.agentImages).values(fresh.map((f, position) => ({ ...f, agentId: agent.id, position })));
      });
    } catch (e) {
      await Promise.all(fresh.map((f) => s.delete(f.key).catch(() => {})));
      throw e;
    }
    await Promise.all(current.map((c) => s.delete(c.key).catch((err) => console.error("  not removed from the CDN", c.key, err))));
    console.log(`  ${agent.slug}: ${fresh.length} images`);
  }
}

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "list" && a) return list(a);
  if (cmd === "add" && a) return add(a, rest);
  if (cmd === "remove" && a && rest[0]) return remove(a, rest[0]);
  if (cmd === "remove-review" && a) return removeReview(a);
  if (cmd === "preview" && a) return preview(a, rest[0]);
  if (cmd === "seed") {
    const args = [a, ...rest].filter((x): x is string => !!x);
    return seed(args.find((x) => !x.startsWith("--")), args.includes("--force"));
  }
  throw new Error(USAGE);
}

main()
  .catch((e) => {
    console.error(e instanceof ImageError ? `image refused: ${e.message}` : (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
