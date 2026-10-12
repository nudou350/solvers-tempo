// Test fixture (not part of the build): spawns `anvil --tempo`, deploys the six Solvers proxies with viem from
// contracts/out, and wires roles. Skipped by callers when anvil is not installed.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as netServer } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getChain } from "../chains.js";
import type { Deployment } from "../deployment.js";

const exe = process.platform === "win32" ? ".exe" : "";
const foundryBin = (name: string) => {
  const env = name === "anvil" ? process.env.ANVIL_BIN : process.env.FORGE_BIN;
  if (env) return env;
  const local = join(homedir(), ".foundry", "bin", `${name}${exe}`);
  return existsSync(local) ? local : name;
};

export function anvilAvailable(): boolean {
  try {
    execFileSync(foundryBin("anvil"), ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Public anvil dev keys (mnemonic "test test … junk"). */
export const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const satisfies readonly Hex[];

export const ROLES = {
  admin: 0, // deployer = default admin in the fixture
  platform: 1,
  verifier: 2,
  creator: 5,
  buyer: 6,
  buyer2: 7,
  relay: 8, // fee payer only
} as const;

export const PATH_USD = "0x20c0000000000000000000000000000000000000" as Address;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = netServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

export type AnvilEnv = {
  rpcUrl: string;
  chain: Chain;
  deployment: Deployment;
  stop: () => Promise<void>;
};

const contractsDir = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "../../../../contracts");

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = join(contractsDir, "out", file, `${name}.json`);
  if (!existsSync(p)) execFileSync(foundryBin("forge"), ["build", "--skip", "test"], { cwd: contractsDir, stdio: "ignore" });
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export async function startAnvil(opts: { minStake?: bigint } = {}): Promise<AnvilEnv> {
  const port = await freePort();
  const proc: ChildProcess = spawn(foundryBin("anvil"), ["--tempo", "--port", String(port), "--silent"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = getChain(31337, rpcUrl);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const deployer = privateKeyToAccount(KEYS[ROLES.admin]!);
  const w = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });

  const deploy = async (file: string, name: string, args: unknown[] = []): Promise<Address> => {
    const a = artifact(file, name);
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress || r.status !== "success") throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  };
  const proxy = async (name: string, init: Hex): Promise<Address> => {
    const impl = await deploy(`${name}.sol`, name);
    return deploy("ERC1967Proxy.sol", "ERC1967Proxy", [impl, init]);
  };
  const call = async (to: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await w.sendTransaction({ to, data: encodeFunctionData({ abi, functionName, args } as never) } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };

  const treasury = "0x000000000000000000000000000000000000dEaD" as Address;
  const reg = artifact("SolversRegistry.sol", "SolversRegistry").abi;
  const encodeInit = (name: string, args: unknown[]) =>
    encodeFunctionData({ abi: artifact(`${name}.sol`, name).abi, functionName: "initialize", args } as never);
  const registry = await proxy(
    "SolversRegistry",
    encodeInit("SolversRegistry", [deployer.address, 0, PATH_USD, treasury, 1000, 500, opts.minStake ?? 0n, 5_000_000n]),
  );
  const license = await proxy("SolversLicense", encodeInit("SolversLicense", [registry, "http://localhost:3018/api/license/"]));
  const credits = await proxy("SolversCredits", encodeInit("SolversCredits", [registry]));
  const reviews = await proxy("SolversReviews", encodeInit("SolversReviews", [registry, license, credits]));
  const escrow = await proxy("SolversEscrow", encodeInit("SolversEscrow", [registry]));
  const staking = await proxy("SolversStaking", encodeInit("SolversStaking", [registry]));
  await call(registry, reg, "setSatellites", [license, credits, reviews, escrow, staking]);
  const role = (r: string) => keccak256(toBytes(r));
  const addr = (i: number) => privateKeyToAccount(KEYS[i]!).address;
  await call(registry, reg, "grantRole", [role("PLATFORM_ROLE"), addr(ROLES.platform)]);
  await call(registry, reg, "grantRole", [role("USAGE_ROLE"), addr(ROLES.platform)]);
  await call(registry, reg, "grantRole", [role("VERIFIER_ROLE"), addr(ROLES.verifier)]);

  const deployment: Deployment = {
    chainId: 31337,
    token: PATH_USD,
    treasury,
    deployBlock: 0n,
    gitSha: "",
    registry,
    license,
    credits,
    reviews,
    escrow,
    staking,
  };
  return {
    rpcUrl,
    chain,
    deployment,
    stop: async () => {
      proc.kill();
    },
  };
}

/** Serves the relay's JSON-RPC handler over HTTP on a free port; the request context carries the client IP. */
export async function serveRelay(
  handle: (body: unknown, ctx: { ip?: string }) => Promise<unknown>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await freePort();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = await handle(body, { ip: req.socket.remoteAddress ?? undefined });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
  });
  await new Promise<void>((r) => server.listen(port, r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
