// `cli:admin` governance commands against a real chain (`anvil --tempo` with the six proxies) and a real database:
// `admin-delay` / `admin-delay-rollback` on the Registry and `upgrade` of one proxy to a freshly deployed implementation of
// the same contract (bytecode from contracts/out; another contract's implementation is refused by its runtime code). Every send is signed by the admin key on the admin nonce lane and its
// fee is paid by RELAY (D20, X21). Dry-runs send nothing; refusals happen before any send.
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWalletClient, encodeFunctionData, erc20Abi, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, anvilAvailable, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;
const contractsOut = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../contracts/out");
const DELAY = 172_800;

describe("cli:admin on anvil: admin delay and upgrades", { skip }, () => {
  let env: AnvilEnv;
  let run: typeof import("../src/cli/admin.js").main;
  let implementationOf: typeof import("../src/cli/admin.js").implementationOf;
  let chainMod: typeof import("../src/chain/index.js");
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let d: typeof import("drizzle-orm");
  let registryAbi: Abi;
  const hashes: Hex[] = [];
  const root = mkdtempSync(join(tmpdir(), "solvers-admincli-"));
  const quiet = { log: console.log, warn: console.warn };

  const send = async (argv: string[]) => {
    const r = await run(argv);
    if (r) hashes.push(r.hash);
    return r;
  };
  const read = <T>(functionName: string) =>
    chainMod.chainContext().publicClient.readContract({ address: env.deployment.registry, abi: registryAbi, functionName } as never) as Promise<T>;

  async function cleanup() {
    if (!hashes.length) return;
    // A fresh anvil reproduces the same tx hashes: drop what the lanes and the indexer recorded for them.
    await db.delete(schema.sentTxs).where(d.inArray(schema.sentTxs.txHash, hashes));
    await db.delete(schema.processedEvents).where(d.inArray(schema.processedEvents.txHash, hashes));
    await db.delete(schema.chainTxs).where(d.inArray(schema.chainTxs.txHash, hashes));
    await db.delete(schema.indexerFailures).where(d.inArray(schema.indexerFailures.txHash, hashes));
  }

  before(async () => {
    env = await startAnvil();
    const deploymentsFile = join(root, "31337.json");
    const dep = env.deployment;
    writeFileSync(
      deploymentsFile,
      JSON.stringify({ chainId: 31337, token: dep.token, treasury: dep.treasury, deployBlock: "0", gitSha: "", registry: dep.registry, license: dep.license, credits: dep.credits, reviews: dep.reviews, escrow: dep.escrow, staking: dep.staking }),
    );
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "31337",
      RPC_URL: env.rpcUrl,
      DEPLOYMENTS_FILE: deploymentsFile,
      PLATFORM_PRIVATE_KEY: KEYS[ROLES.platform],
      RELAY_PRIVATE_KEY: KEYS[ROLES.relay],
      VERIFIER_PRIVATE_KEY: KEYS[ROLES.verifier],
      // The fixture's deployer is the Registry's default admin (delay 0).
      ADMIN_PRIVATE_KEY: KEYS[ROLES.admin],
      TREASURY_ADDRESS: dep.treasury,
      JWT_SECRET: "j".repeat(40),
      SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
      SEARCH_MODE: "fts",
    });
    console.log = () => {};
    console.warn = () => {};
    ({ main: run, implementationOf } = await import("../src/cli/admin.js"));
    chainMod = await import("../src/chain/index.js");
    ({ db, schema, pool } = await import("../src/db/index.js"));
    d = await import("drizzle-orm");
    registryAbi = (await import("@solvers/contracts-client")).solversRegistryAbi as Abi;
  });

  after(async () => {
    console.log = quiet.log;
    console.warn = quiet.warn;
    rmSync(root, { recursive: true, force: true });
    if (db) {
      await cleanup();
      await pool.end();
    }
    await env?.stop();
  });

  it("admin-delay: dry-run sends nothing; --yes schedules the change through the admin lane, fee paid by RELAY", async () => {
    assert.equal(await send(["admin-delay", String(DELAY)]), null);
    assert.deepEqual(await read<[number, number]>("pendingDefaultAdminDelay"), [0, 0], "the dry-run scheduled nothing");

    const relay = privateKeyToAccount(KEYS[ROLES.relay]!).address;
    const admin = privateKeyToAccount(KEYS[ROLES.admin]!).address;
    const pc = chainMod.chainContext().publicClient;
    // The fixture's fee token and payment token are both pathUSD.
    const adminBalance = () => pc.readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [admin] });
    const balanceBefore = await adminBalance();
    const r = await send(["admin-delay", String(DELAY), "--yes"]);
    assert.ok(r);
    const tx = (await pc.getTransaction({ hash: r.hash })) as unknown as { from: Address };
    assert.equal(tx.from.toLowerCase(), admin.toLowerCase(), "signed by the admin key");
    const receipt = (await pc.getTransactionReceipt({ hash: r.hash })) as unknown as { feePayer?: Address; feeToken?: Address };
    assert.equal(String(receipt.feePayer).toLowerCase(), relay.toLowerCase(), "the receipt's fee payer is RELAY");
    assert.equal(String(receipt.feeToken).toLowerCase(), PATH_USD.toLowerCase(), "fee paid in the fixture's fee token");
    assert.equal(await adminBalance(), balanceBefore, "the admin key paid nothing");
    const [pending, at] = await read<[number, number]>("pendingDefaultAdminDelay");
    assert.equal(pending, DELAY);
    assert.ok(at > Math.floor(Date.now() / 1000) + DELAY - 120, "an increase from 0 waits min(new delay, 5 days)");
    assert.equal(await read<number>("defaultAdminDelay"), 0, "not in force before the schedule");
    const [sent] = await db.select().from(schema.sentTxs).where(d.eq(schema.sentTxs.txHash, r.hash));
    assert.equal(sent?.kind, "admin-admin-delay");
  });

  it("admin-delay-rollback cancels the scheduled change; a second rollback is refused before sending", async () => {
    assert.ok(await send(["admin-delay-rollback", "--yes"]));
    assert.deepEqual(await read<[number, number]>("pendingDefaultAdminDelay"), [0, 0]);
    await assert.rejects(send(["admin-delay-rollback", "--yes"]), /no scheduled admin delay change/);
    await assert.rejects(send(["admin-delay", "0", "--yes"]), /already 0 s: nothing to change/);
  });

  it("upgrade: refuses an address without code, the deployment's own proxies/token and the current implementation", async () => {
    const before = await implementationOf(chainMod.chainContext(), env.deployment.license);
    await assert.rejects(send(["upgrade", "license", "0x000000000000000000000000000000000000beef", "--yes"]), /has no code/);
    await assert.rejects(send(["upgrade", "license", env.deployment.credits, "--yes"]), /proxy of this deployment/);
    await assert.rejects(send(["upgrade", "license", env.deployment.token, "--yes"]), /proxy of this deployment/);
    await assert.rejects(send(["upgrade", "license", before, "--yes"]), /already the implementation/);
    assert.equal(await implementationOf(chainMod.chainContext(), env.deployment.license), before);
  });

  it("upgrade license: a Credits implementation is refused; a freshly deployed SolversLicense passes (dry-run first, then the ERC-1967 slot changes and state is kept)", async () => {
    const ctx = chainMod.chainContext();
    const pc = ctx.publicClient;
    const file = join(contractsOut, "SolversLicense.sol", "SolversLicense.json");
    assert.ok(existsSync(file), "contracts/out has the SolversLicense artifact (startAnvil builds it)");
    const art = JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const deployer = createWalletClient({ account: privateKeyToAccount(KEYS[ROLES.creator]!), chain: env.chain, transport: http(env.rpcUrl) });
    const deployHash = await deployer.deployContract({ abi: art.abi, bytecode: art.bytecode.object } as never);
    const receipt = await pc.waitForTransactionReceipt({ hash: deployHash });
    const newImpl = receipt.contractAddress!.toLowerCase();

    // A stray proxy (code, but proxiableUUID() is delegated and the implementation's notDelegated guard reverts).
    const proxyArt = JSON.parse(readFileSync(join(contractsOut, "ERC1967Proxy.sol", "ERC1967Proxy.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    // OpenZeppelin's ERC1967Proxy refuses empty init data (ERC1967ProxyUninitialized): delegate a harmless view call.
    const viewCall = encodeFunctionData({ abi: art.abi, functionName: "registry" } as never);
    const strayHash = await deployer.deployContract({ abi: proxyArt.abi, bytecode: proxyArt.bytecode.object, args: [newImpl, viewCall] } as never);
    const stray = (await pc.waitForTransactionReceipt({ hash: strayHash })).contractAddress!;
    await assert.rejects(send(["upgrade", "license", stray, "--yes"]), /does not answer proxiableUUID/);

    // Another contract's implementation answers the same proxiableUUID: only the runtime code check refuses it.
    const creditsArt = JSON.parse(readFileSync(join(contractsOut, "SolversCredits.sol", "SolversCredits.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const creditsHash = await deployer.deployContract({ abi: creditsArt.abi, bytecode: creditsArt.bytecode.object } as never);
    const creditsImpl = (await pc.waitForTransactionReceipt({ hash: creditsHash })).contractAddress!;
    await assert.rejects(send(["upgrade", "license", creditsImpl]), /is not a SolversLicense implementation built from this checkout/, "dry-run refused too");
    await assert.rejects(send(["upgrade", "license", creditsImpl, "--yes"]), /is not a SolversLicense implementation built from this checkout/);

    const oldImpl = await implementationOf(ctx, env.deployment.license);
    const baseBefore = await pc.readContract({ address: env.deployment.license, abi: art.abi, functionName: "registry" } as never);
    assert.equal(await send(["upgrade", "license", newImpl]), null, "dry-run");
    assert.equal(await implementationOf(ctx, env.deployment.license), oldImpl, "the dry-run upgraded nothing");

    const r = await send(["upgrade", "license", newImpl, "--yes"]);
    assert.ok(r);
    const after = await implementationOf(ctx, env.deployment.license);
    assert.notEqual(after, oldImpl);
    assert.equal(after, newImpl, "the ERC-1967 implementation slot points at the new implementation");
    assert.equal(
      String(await pc.readContract({ address: env.deployment.license, abi: art.abi, functionName: "registry" } as never)).toLowerCase(),
      String(baseBefore).toLowerCase(),
      "proxy storage kept",
    );
  });

  it("a non-admin key is refused before anything is sent", async () => {
    const keyFile = join(root, "not-admin.key");
    writeFileSync(keyFile, KEYS[ROLES.buyer]!);
    await assert.rejects(send(["admin-delay", String(DELAY), "--yes", "--key-file", keyFile]), /needs the signature of/);
    assert.deepEqual(await read<[number, number]>("pendingDefaultAdminDelay"), [0, 0]);
  });

  it("admin-delay takes effect after the schedule (last: moves anvil's clock forward)", async () => {
    assert.ok(await send(["admin-delay", String(DELAY), "--yes"]));
    const pc = chainMod.chainContext().publicClient as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> };
    await pc.request({ method: "evm_increaseTime", params: [DELAY + 1] });
    await pc.request({ method: "evm_mine", params: [] });
    assert.equal(await read<number>("defaultAdminDelay"), DELAY);
    assert.deepEqual(await read<[number, number]>("pendingDefaultAdminDelay"), [0, 0]);
  });
});
