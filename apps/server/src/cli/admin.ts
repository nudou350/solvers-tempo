// Governance operations of the contracts (default admin, admin delay, guardians, config, pause, slash, stake exit,
// disputes, license base URI, stray tokens, UUPS upgrades).
//
//   pnpm --filter @solvers/server cli:admin propose <new-admin>          dry-run (default): only READS and simulates
//   pnpm --filter @solvers/server cli:admin accept --key-file <new-admin.key>
//   pnpm --filter @solvers/server cli:admin set-config fee-bps=1000 min-price=5
//   pnpm --filter @solvers/server cli:admin set-pause entries,payments
//   pnpm --filter @solvers/server cli:admin grant-role guardian 0x...
//   pnpm --filter @solvers/server cli:admin propose-slash <slug> <amount> <reason>
//   pnpm --filter @solvers/server cli:admin resolve-dispute <escrowId> <index> refund
//   pnpm --filter @solvers/server cli:admin admin-delay 172800
//   pnpm --filter @solvers/server cli:admin upgrade license <new-implementation> [--call <hex>]
//   ... add --yes to SEND (without --yes nothing is sent)
//
// Every transaction is signed by the signer key on the admin nonce lane and its fee is paid by the RELAY key (D20), so
// the cold key never holds tokens (also for the accept, the admin delay and upgrades: X21). Keys are never printed: only addresses and file paths. See `USAGE` in admin-args.ts.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeSolversError, type Call } from "@solvers/chain";
import { solversEscrowAbi, solversLicenseAbi, solversRegistryAbi, solversStakingAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, fromUnits, MILESTONE_STATUS, PAUSE_FLAGS } from "@solvers/shared";
import { eq, or } from "drizzle-orm";
import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { explorerUrl, type ChainContext } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { db, pool, schema } from "../db/index.js";
import { env } from "../env.js";
import { processTxHash } from "../indexer/index.js";
import { parseAdminArgs, reasonHashOf, USAGE, UsageError, type AdminArgs, type RoleName, type UpgradeableContract } from "./admin-args.js";
import {
  adminDelayChangeAt,
  assertRoleGrantAllowed,
  ERC1967_IMPLEMENTATION_SLOT,
  decidePauseSigner,
  KeySourceError,
  MAX_STAKE_EXIT_EXTENSIONS,
  NetworkError,
  PauseRuleError,
  RELAY_CHECK_NOTE,
  runtimeCodeMismatch,
  type RuntimeArtifact,
  slashWait,
  STAKE_EXIT_EXTENSION_SECS,
} from "./admin-guard.js";
import { initCliChain, txLink } from "./cli-chain.js";

class OpError extends Error {}

const ROLE_ID: Record<RoleName, Hex> = {
  platform: keccak256(toBytes("PLATFORM_ROLE")),
  usage: keccak256(toBytes("USAGE_ROLE")),
  verifier: keccak256(toBytes("VERIFIER_ROLE")),
  guardian: keccak256(toBytes("GUARDIAN_ROLE")),
};
const ZERO = "0x0000000000000000000000000000000000000000";
/** UUPSUpgradeable (OpenZeppelin v5): the same two functions on all six implementations. */
const uupsAbi = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data) payable", "function proxiableUUID() view returns (bytes32)"]);
/** Solidity contract behind each proxy: `upgrade` compares the new implementation with `contracts/out/<Name>.sol/<Name>.json`. */
const CONTRACT_NAME: Record<UpgradeableContract, string> = {
  registry: "SolversRegistry",
  license: "SolversLicense",
  credits: "SolversCredits",
  reviews: "SolversReviews",
  escrow: "SolversEscrow",
  staking: "SolversStaking",
};
/** Foundry output of this checkout (same depth from src/cli and dist/cli). */
const CONTRACTS_OUT = fileURLToPath(new URL("../../../../contracts/out/", import.meta.url));

/** The local build's runtime code of `contract`, or a refusal saying how to produce it. */
function localRuntimeArtifact(contract: UpgradeableContract): { name: string; file: string; artifact: RuntimeArtifact } {
  const name = CONTRACT_NAME[contract];
  const file = `${CONTRACTS_OUT}${name}.sol/${name}.json`;
  if (!existsSync(file)) {
    throw new OpError(`cannot check the new implementation: ${file} not found. Run \`forge build\` in contracts/ at the commit the implementation was deployed from (the one Upgrade.s.sol validated), then repeat.`);
  }
  const artifact = (JSON.parse(readFileSync(file, "utf8")) as { deployedBytecode?: RuntimeArtifact }).deployedBytecode;
  if (!artifact?.object) throw new OpError(`${file} has no deployedBytecode: rebuild with \`forge build\` in contracts/`);
  return { name, file, artifact };
}

const secsText = (s: number) => `${s} s${s >= 3600 ? ` (${+(s / 3600).toFixed(2)} h)` : ""}`;

const amount = (units: bigint) => `${fromUnits(units, env.PAYMENT_TOKEN_DECIMALS)} ${env.PAYMENT_TOKEN_SYMBOL}`;
const iso = (secs: bigint | number) => new Date(Number(secs) * 1000).toISOString();
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const PAUSE_TEXT = (f: number) =>
  f === 0
    ? "none"
    : [f & PAUSE_FLAGS.ENTRIES ? "entries" : null, f & PAUSE_FLAGS.PAYMENTS ? "payments" : null, f & PAUSE_FLAGS.TRANSFERS ? "transfers" : null].filter(Boolean).join(",");

/** Who must sign and how to provide the key. */
type SignerPlan = { role: string; expected: string; howTo: string };
type Plan = { title: string; signer: SignerPlan; notes: string[]; calls: Call[]; ref: string };

/** Agent by slug or 32-hex id (catalog row) -> on-chain id. */
async function agentRef(ref: string): Promise<{ id: string; slug: string; bytes32: Hex }> {
  const [row] = await db
    .select({ id: schema.agents.id, slug: schema.agents.slug })
    .from(schema.agents)
    .where(or(eq(schema.agents.slug, ref), eq(schema.agents.id, ref.toLowerCase())));
  if (row) return { ...row, bytes32: agentIdToBytes32(row.id) };
  if (/^[0-9a-fA-F]{32}$/.test(ref)) return { id: ref.toLowerCase(), slug: ref, bytes32: agentIdToBytes32(ref) };
  throw new OpError(`Solver "${ref}" not found (use the slug or the 32-hex id)`);
}

async function planFor(c: ChainContext, args: AdminArgs): Promise<Plan> {
  const pc = c.publicClient;
  const d = c.deployment;
  const reg = { address: d.registry, abi: solversRegistryAbi } as const;
  const staking = { address: d.staking, abi: solversStakingAbi } as const;
  const admin = (await pc.readContract({ ...reg, functionName: "defaultAdmin" })).toLowerCase();
  const adminSigner: SignerPlan = { role: "default admin", expected: admin, howTo: `run it where the admin key (${admin}) is, with --key-file <file> (or ADMIN_PRIVATE_KEY off mainnet)` };
  const regCall = (data: Hex): Call => ({ to: d.registry, data });
  const cmd = args.command;

  switch (cmd.cmd) {
    case "propose": {
      if (same(cmd.newAdmin, admin)) throw new OpError("the new admin is the current admin: nothing to change");
      const [pending] = await pc.readContract({ ...reg, functionName: "pendingDefaultAdmin" });
      const delay = await pc.readContract({ ...reg, functionName: "defaultAdminDelay" });
      return {
        title: `Begin the default admin transfer to ${cmd.newAdmin} (step 1 of 2)`,
        signer: adminSigner,
        notes: [
          `The transfer only takes effect when ${cmd.newAdmin} runs "accept" with its key, after the admin delay (${delay} s).`,
          ...(pending !== ZERO ? [`This REPLACES the pending transfer to ${pending}.`] : []),
          "Until it is accepted, the current admin keeps every power. Wrong address: use \"cancel\".",
        ],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "beginDefaultAdminTransfer", args: [cmd.newAdmin as Address] }))],
        ref: cmd.newAdmin,
      };
    }
    case "accept": {
      const [pending, schedule] = await pc.readContract({ ...reg, functionName: "pendingDefaultAdmin" });
      if (pending === ZERO) throw new OpError("there is no pending default admin transfer");
      const now = Math.floor(Date.now() / 1000);
      if (args.yes && Number(schedule) > now) throw new OpError(`too early: the transfer can be accepted from ${iso(schedule)}`);
      return {
        title: `Accept the default admin role (step 2 of 2): ${admin} -> ${pending.toLowerCase()}`,
        signer: { role: "new admin", expected: pending.toLowerCase(), howTo: `the key of ${pending} must be on this computer: run with --key-file <new admin key file>` },
        notes: [`Acceptable from ${iso(schedule)}.`, "Afterwards the old key is no longer admin; update the key used by cli:approve/cli:suspend."],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "acceptDefaultAdminTransfer" }))],
        ref: pending.toLowerCase(),
      };
    }
    case "cancel": {
      const [pending] = await pc.readContract({ ...reg, functionName: "pendingDefaultAdmin" });
      if (pending === ZERO) throw new OpError("there is no pending default admin transfer");
      return {
        title: `Cancel the pending admin transfer to ${pending.toLowerCase()}`,
        signer: adminSigner,
        notes: [],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "cancelDefaultAdminTransfer" }))],
        ref: pending.toLowerCase(),
      };
    }
    case "set-config": {
      const [treasury, feeBps, platformRoyaltyBps, , minStake, minPrice] = await pc.readContract({ ...reg, functionName: "config" });
      const next = {
        treasury: (cmd.change.treasury ?? treasury.toLowerCase()) as Address,
        feeBps: cmd.change.feeBps ?? feeBps,
        platformRoyaltyBps: cmd.change.platformRoyaltyBps ?? platformRoyaltyBps,
        minStake: cmd.change.minStake ?? minStake,
        minPrice: cmd.change.minPrice ?? minPrice,
      };
      if (/^0x20c0/i.test(next.treasury)) throw new OpError("the treasury cannot be a TIP-20 token address (transfers to it revert)");
      const rows = [
        ["treasury", treasury.toLowerCase(), next.treasury],
        ["fee bps", feeBps, next.feeBps],
        ["platform royalty bps", platformRoyaltyBps, next.platformRoyaltyBps],
        ["min stake", amount(minStake), amount(next.minStake)],
        ["min price", amount(minPrice), amount(next.minPrice)],
      ] as const;
      if (rows.every(([, a, b]) => String(a) === String(b))) throw new OpError("the configuration already has these values: nothing to change");
      return {
        title: "Update the Registry configuration",
        signer: adminSigner,
        notes: [
          ...rows.map(([k, a, b]) => `${k}: ${a}${String(a) === String(b) ? " (unchanged)" : ` -> ${b}`}`),
          "Escrows keep the fee frozen at their creation. The platform royalty applies to every later license transfer (creator + platform <= 2500 bps).",
        ],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "setConfig", args: [next.treasury, next.feeBps, next.platformRoyaltyBps, next.minStake, next.minPrice] }))],
        ref: "config",
      };
    }
    case "set-pause": {
      const current = await pc.readContract({ ...reg, functionName: "pauseFlags" });
      const key = c.accounts.admin?.address.toLowerCase() ?? null;
      const keyIsGuardian = key ? await pc.readContract({ ...reg, functionName: "hasRole", args: [ROLE_ID.guardian, key as Address] }) : false;
      const { role, unpausing } = decidePauseSigner({ current, next: cmd.flags, admin, keyAddress: key, keyIsGuardian });
      return {
        title: `Emergency pause: ${PAUSE_TEXT(current)} -> ${PAUSE_TEXT(cmd.flags)}`,
        signer: role === "guardian" ? { role: "guardian", expected: key!, howTo: "use --key-file <guardian key>" } : adminSigner,
        notes: [
          "entries (1): registerAgent, purchases, credits, new guarantees. payments (2): guarantee releases and dispute decisions. transfers (4): license transfers (admin only).",
          "Never paused: markPassed, buyer exits (dispute, cancel undelivered, stale dispute), staking, reviews, claims, admin operations.",
          unpausing ? "This RELEASES operations: only the admin can." : "Only the admin can release the pause later (a guardian only adds bits).",
        ],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "setPause", args: [cmd.flags] }))],
        ref: String(cmd.flags),
      };
    }
    case "grant-role":
    case "revoke-role": {
      if (cmd.cmd === "grant-role") {
        try {
          assertRoleGrantAllowed({ role: cmd.role, account: cmd.account, relay: c.accounts.relay.address, platform: c.accounts.platform.address, chainId: c.chain.id });
        } catch (e) {
          throw new OpError((e as Error).message);
        }
      }
      const has = await pc.readContract({ ...reg, functionName: "hasRole", args: [ROLE_ID[cmd.role], cmd.account as Address] });
      if (cmd.cmd === "grant-role" && has) throw new OpError(`${cmd.account} already has the ${cmd.role} role`);
      if (cmd.cmd === "revoke-role" && !has) throw new OpError(`${cmd.account} does not have the ${cmd.role} role`);
      const fn = cmd.cmd === "grant-role" ? "grantRole" : "revokeRole";
      return {
        title: `${cmd.cmd === "grant-role" ? "Grant" : "Revoke"} the ${cmd.role} role ${cmd.cmd === "grant-role" ? "to" : "from"} ${cmd.account}`,
        signer: adminSigner,
        notes: [
          ...(cmd.role === "guardian" ? ["A guardian can only ADD pause bits (never transfers); releasing is the admin's."] : []),
          ...(cmd.cmd === "grant-role" ? [RELAY_CHECK_NOTE] : []),
        ],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: fn, args: [ROLE_ID[cmd.role], cmd.account as Address] }))],
        ref: `${cmd.role}:${cmd.account}`,
      };
    }
    case "propose-slash": {
      const a = await agentRef(cmd.slug);
      const slash = await pc.readContract({ ...staking, functionName: "slashOf", args: [a.bytes32] });
      if (slash.proposedAt !== 0) throw new OpError(`there is already a slash proposal for "${a.slug}": use execute-slash (after 72 h) or cancel-slash`);
      const stake = await pc.readContract({ ...reg, functionName: "stakeOf", args: [a.bytes32] });
      if (cmd.amount > stake) throw new OpError(`the Solver's stake is ${amount(stake)}; cannot slash ${amount(cmd.amount)}`);
      const hash = reasonHashOf(cmd.reason);
      return {
        title: `Propose slashing ${amount(cmd.amount)} of ${a.slug}`,
        signer: adminSigner,
        notes: [
          `Reason (text): "${cmd.reason}". reason hash = sha256 of the reason = ${hash} (keep the text: only the hash goes on-chain).`,
          `Current stake: ${amount(stake)}. An Active Solver is SUSPENDED now (out of the store, no purchases).`,
          "Executable only 72 h later (execute-slash), until 14 days after that. The creator may contest (evidence only); the admin may cancel.",
          "While pending, the creator cannot withdraw the stake. The money goes to the treasury.",
        ],
        calls: [{ to: d.staking, data: encodeFunctionData({ abi: solversStakingAbi, functionName: "proposeSlash", args: [a.bytes32, cmd.amount, hash] }) }],
        ref: a.id,
      };
    }
    case "execute-slash": {
      const a = await agentRef(cmd.slug);
      const p = await pc.readContract({ ...staking, functionName: "slashOf", args: [a.bytes32] });
      if (p.proposedAt === 0) throw new OpError(`there is no slash proposal for "${a.slug}"`);
      const wait = slashWait(p.proposedAt, Math.floor(Date.now() / 1000));
      if (wait.expired && args.yes) throw new OpError(`the proposal expired (${wait.text}; limit ${iso(wait.expiresAt)}): the contract refuses it (SlashExpired). Use cancel-slash and propose again if needed`);
      if (wait.remainingSecs > 0 && args.yes) throw new OpError(`too early: ${wait.text} (executable from ${iso(wait.executableAt)})`);
      const stake = await pc.readContract({ ...reg, functionName: "stakeOf", args: [a.bytes32] });
      return {
        title: `Execute the slash of ${amount(p.amount)} of ${a.slug}`,
        signer: adminSigner,
        notes: [
          `Window: proposed ${iso(p.proposedAt)}, executable from ${iso(wait.executableAt)} until ${iso(wait.expiresAt)}: ${wait.text}.`,
          `Reason hash = ${p.reasonHash}. ${p.contestedAt === 0 ? "Not contested." : `CONTESTED by the creator at ${iso(p.contestedAt)} (evidence ${p.contestHash}): review it before executing.`}`,
          `Current stake: ${amount(stake)}. The treasury receives min(proposed amount, stake).`,
          "The Solver stays suspended (or retired): reactivating needs approveAgent and stake >= the minimum.",
        ],
        calls: [{ to: d.staking, data: encodeFunctionData({ abi: solversStakingAbi, functionName: "executeSlash", args: [a.bytes32] }) }],
        ref: a.id,
      };
    }
    case "cancel-slash": {
      const a = await agentRef(cmd.slug);
      const p = await pc.readContract({ ...staking, functionName: "slashOf", args: [a.bytes32] });
      if (p.proposedAt === 0) throw new OpError(`there is no slash proposal for "${a.slug}"`);
      return {
        title: `Cancel the slash proposal of ${amount(p.amount)} of ${a.slug}`,
        signer: adminSigner,
        notes: ["The Solver stays suspended: reactivating needs approveAgent (cli:suspend --resume).", "After 72 h + 14 days the creator can also cancel it from the site."],
        calls: [{ to: d.staking, data: encodeFunctionData({ abi: solversStakingAbi, functionName: "cancelSlash", args: [a.bytes32] }) }],
        ref: a.id,
      };
    }
    case "extend-stake-exit": {
      const a = await agentRef(cmd.slug);
      const x = await pc.readContract({ ...staking, functionName: "stakeExitOf", args: [a.bytes32] });
      if (x.exitAt === 0) throw new OpError(`"${a.slug}" has not requested a stake exit`);
      if (x.extensions >= MAX_STAKE_EXIT_EXTENSIONS) throw new OpError(`the wait was already extended ${x.extensions} times, the maximum (${MAX_STAKE_EXIT_EXTENSIONS})`);
      const hash = reasonHashOf(cmd.reason);
      return {
        title: `Extend the stake exit of ${a.slug} by 30 days (${x.extensions + 1} of ${MAX_STAKE_EXIT_EXTENSIONS})`,
        signer: adminSigner,
        notes: [
          `Withdrawal currently allowed from ${iso(x.exitAt)}; after the extension, from ${iso(Number(x.exitAt) + STAKE_EXIT_EXTENSION_SECS)}.`,
          `Reason (text): "${cmd.reason}". reason hash = sha256 = ${hash}.`,
        ],
        calls: [{ to: d.staking, data: encodeFunctionData({ abi: solversStakingAbi, functionName: "extendStakeExit", args: [a.bytes32, hash] }) }],
        ref: a.id,
      };
    }
    case "resolve-dispute": {
      const e = await pc.readContract({ address: d.escrow, abi: solversEscrowAbi, functionName: "escrowOf", args: [cmd.escrowId] });
      const [buyer, , creator, total, feeBps, , , milestones] = e;
      const m = milestones[cmd.index];
      if (!m) throw new OpError(`guarantee ${cmd.escrowId} has no step ${cmd.index}`);
      if (m.status !== MILESTONE_STATUS.Disputed) throw new OpError(`step ${cmd.index} of guarantee ${cmd.escrowId} is not disputed (status ${m.status})`);
      return {
        title: `Resolve the dispute of guarantee ${cmd.escrowId}, step ${cmd.index}: ${cmd.refund ? "REFUND the buyer" : "RELEASE to the creator"}`,
        signer: adminSigner,
        notes: [
          `Buyer ${buyer.toLowerCase()}, creator ${creator.toLowerCase()}, total ${amount(total)}, step ${amount(m.amount)}, fee ${feeBps} bps (frozen).`,
          `Dispute reason hash ${m.disputeReasonHash}, opened ${iso(m.disputedAt)}.`,
          cmd.refund ? "Refund: the full step amount goes back to the buyer (no fee) and the Solver records a lost dispute." : "Release: the creator is paid (minus the fee) and the buyer records a lost dispute.",
          "Blocked while the PAYMENTS pause is on.",
        ],
        calls: [{ to: d.escrow, data: encodeFunctionData({ abi: solversEscrowAbi, functionName: "resolveDispute", args: [cmd.escrowId, cmd.index, cmd.refund] }) }],
        ref: `${cmd.escrowId}:${cmd.index}`,
      };
    }
    case "set-base-uri":
      return {
        title: `Set the license metadata base URI to ${cmd.uri}`,
        signer: adminSigner,
        notes: ["tokenURI(id) = base URI + id (served by GET /api/license/:id)."],
        calls: [{ to: d.license, data: encodeFunctionData({ abi: solversLicenseAbi, functionName: "setBaseURI", args: [cmd.uri] }) }],
        ref: cmd.uri,
      };
    case "admin-delay": {
      // Only the Registry carries AccessControlDefaultAdminRules: the satellites check roles (and authorize upgrades)
      // through the Registry's hasRole, so this one delay governs every contract.
      const current = Number(await pc.readContract({ ...reg, functionName: "defaultAdminDelay" }));
      const [pendingDelay, pendingAt] = await pc.readContract({ ...reg, functionName: "pendingDefaultAdminDelay" });
      const increaseWait = Number(await pc.readContract({ ...reg, functionName: "defaultAdminDelayIncreaseWait" }));
      if (cmd.seconds === current && pendingAt === 0) throw new OpError(`the admin delay is already ${secsText(current)}: nothing to change`);
      const at = adminDelayChangeAt({ current, next: cmd.seconds, increaseWait, nowSecs: Math.floor(Date.now() / 1000) });
      return {
        title: `Change the default admin transfer delay: ${secsText(current)} -> ${secsText(cmd.seconds)}`,
        signer: adminSigner,
        notes: [
          `Scheduled now, it takes effect around ${iso(at)} (an increase waits min(new delay, ${secsText(increaseWait)}); a decrease waits the difference). Until then "admin-delay-rollback" cancels it.`,
          ...(pendingAt !== 0 ? [`This REPLACES the scheduled change to ${secsText(Number(pendingDelay))} (effective ${iso(pendingAt)}).`] : []),
          "Only the Registry has this delay; the five satellites use the Registry's roles, so it covers every contract. It applies to future admin transfers (propose, then accept).",
        ],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "changeDefaultAdminDelay", args: [cmd.seconds] }))],
        ref: String(cmd.seconds),
      };
    }
    case "admin-delay-rollback": {
      const [pendingDelay, pendingAt] = await pc.readContract({ ...reg, functionName: "pendingDefaultAdminDelay" });
      if (pendingAt === 0) throw new OpError("there is no scheduled admin delay change (a change whose time has passed is already in force)");
      const current = Number(await pc.readContract({ ...reg, functionName: "defaultAdminDelay" }));
      return {
        title: `Cancel the scheduled admin delay change to ${secsText(Number(pendingDelay))}`,
        signer: adminSigner,
        notes: [`Scheduled for ${iso(pendingAt)}; the delay stays ${secsText(current)}.`],
        calls: [regCall(encodeFunctionData({ abi: solversRegistryAbi, functionName: "rollbackDefaultAdminDelay" }))],
        ref: String(pendingDelay),
      };
    }
    case "upgrade": {
      const proxy = d[cmd.contract];
      const impl = cmd.implementation as Address;
      const current = await implementationOf(c, proxy);
      if (same(current, impl)) throw new OpError(`${impl} is already the implementation of the ${cmd.contract} proxy: nothing to change`);
      if ([d.registry, d.license, d.credits, d.reviews, d.escrow, d.staking, d.token].some((a) => same(a, impl))) {
        throw new OpError(`${impl} is a proxy of this deployment (or the payment token), not a new implementation`);
      }
      const code = await pc.getCode({ address: impl });
      if (!code || code === "0x") throw new OpError(`${impl} has no code: deploy the implementation first (contracts/script/Upgrade.s.sol, UPGRADE_MODE=prepare)`);
      let uuid: Hex;
      try {
        uuid = await pc.readContract({ address: impl, abi: uupsAbi, functionName: "proxiableUUID" });
      } catch {
        throw new OpError(`${impl} does not answer proxiableUUID(): not a UUPS implementation (or it is a proxy)`);
      }
      if (uuid.toLowerCase() !== ERC1967_IMPLEMENTATION_SLOT) throw new OpError(`${impl} proxiableUUID() = ${uuid}, not the ERC-1967 implementation slot`);
      // proxiableUUID is the same on all six implementations: only the code tells a License from a Credits implementation.
      const local = localRuntimeArtifact(cmd.contract);
      const mismatch = runtimeCodeMismatch(code, local.artifact);
      if (mismatch) {
        throw new OpError(
          `${impl} is not a ${local.name} implementation built from this checkout: ${mismatch} (immutables and metadata hash ignored). Check that the address is the ${cmd.contract} implementation deployed by Upgrade.s.sol prepare and that contracts/ is at the same commit (\`forge build\`).`,
        );
      }
      return {
        title: `Upgrade the ${cmd.contract} proxy ${proxy.toLowerCase()}: ${current} -> ${impl}`,
        signer: adminSigner,
        notes: [
          `REQUIRED BEFORE THIS: contracts/script/Upgrade.s.sol must have passed for this contract (validate mode against the reference build of the LIVE implementation, then UPGRADE_MODE=prepare deployed this implementation). This command checks that the address answers the UUPS proxiableUUID and that its runtime code is ${local.name} from the local build (${local.file}, immutables and metadata hash ignored); it cannot check storage layout or upgrade safety.`,
          cmd.data === "0x"
            ? "No call after the upgrade (--call not given)."
            : `Runs ${cmd.data.slice(0, 10)} (${(cmd.data.length - 2) / 2} bytes, --call) on the proxy right after the upgrade, in the same transaction.`,
          `Afterwards, from contracts/: node script/record-upgrade.mjs ${c.chain.id} --rpc-url <rpc> [--sha <commit>], verify the implementation and regenerate the client (docs/deploy-runbook.md 4.6).`,
        ],
        calls: [{ to: proxy, data: encodeFunctionData({ abi: uupsAbi, functionName: "upgradeToAndCall", args: [impl, cmd.data] }) }],
        ref: `${cmd.contract}:${impl}`,
      };
    }
    case "sweep-stray": {
      const target = d[cmd.contract];
      return {
        title: `Sweep stray tokens of the ${cmd.contract} contract to ${cmd.to}`,
        signer: adminSigner,
        notes: ["Only the balance above the locked funds and the deferred payouts moves (sweepStray); nothing owed to anyone is touched."],
        calls: [{ to: target, data: encodeFunctionData({ abi: solversLicenseAbi, functionName: "sweepStray", args: [cmd.to as Address] }) }],
        ref: `${cmd.contract}:${cmd.to}`,
      };
    }
  }
}

/** Implementation address in a proxy's ERC-1967 slot (lowercase). */
export async function implementationOf(c: ChainContext, proxy: Address): Promise<string> {
  const word = (await c.publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT })) ?? "0x";
  return `0x${word.slice(2).padStart(64, "0").slice(-40)}`.toLowerCase();
}

async function simulate(c: ChainContext, from: string, calls: Call[]): Promise<string | null> {
  try {
    await c.publicClient.estimateGas({ account: from as Address, calls: calls.map((x) => ({ to: x.to, data: x.data })) } as never);
    return null;
  } catch (e) {
    const d = decodeSolversError(e);
    return d.name === "Unknown" ? ((e as Error).message ?? "refused").split("\n")[0]! : `${d.name}: ${d.message}`;
  }
}

/** Runs one `cli:admin` command; returns the hash when something was sent (null for a dry-run). Exported for tests. */
export async function main(argv: readonly string[]): Promise<{ hash: Hex } | null> {
  const args = parseAdminArgs(argv, env.PAYMENT_TOKEN_DECIMALS);
  // Network guard (also for dry-runs) and the signer key: on mainnet only --key-file.
  const { ctx, network, warning, signer } = await initCliChain({ keyFile: args.keyFile, allowNetwork: args.allowNetwork });
  if (warning) console.warn(warning);
  const plan = await planFor(ctx, args);
  if (signer && !same(signer.address, plan.signer.expected)) {
    throw new OpError(`the key belongs to ${signer.address}, but this operation needs the signature of ${plan.signer.expected} (${plan.signer.role})`);
  }

  console.log(`== ${plan.title} ==`);
  console.log(`Mode ............ ${args.yes ? "EXECUTE (--yes)" : "DRY-RUN (nothing will be sent)"}  | network: ${network} (chain ${env.CHAIN_ID})`);
  console.log(`Registry ........ ${ctx.deployment.registry}`);
  console.log(`Signs ........... ${plan.signer.role} ${plan.signer.expected}  [${signer ? "key available" : "key NOT available here"}]`);
  console.log(`Fee payer ....... ${ctx.accounts.relay.address} (RELAY; the signer pays nothing)`);
  for (const call of plan.calls) console.log(`Call ............ ${call.to} ${call.data.slice(0, 10)}`);
  for (const n of plan.notes) console.log(`Note: ${n}`);
  const refused = await simulate(ctx, plan.signer.expected, plan.calls);
  console.log(`Simulation ...... ${refused ? `REFUSED: ${refused}` : "ok"}`);

  if (!args.yes) {
    console.log("\nDry-run finished, nothing was sent. To execute, repeat the command with --yes.");
    if (!signer) console.log(`Note: ${plan.signer.howTo}.`);
    return null;
  }
  if (!signer) throw new OpError(`missing the signature of ${plan.signer.role}: ${plan.signer.howTo}`);
  if (refused) throw new OpError(`the simulation refused the operation: ${refused}`);
  const r = await sendServerCalls({ signer: "admin", lane: "admin", calls: plan.calls, kind: `admin-${args.command.cmd}`, ref: plan.ref });
  console.log(`\nSent and confirmed: ${txLink(explorerUrl, r.hash)}`);
  try {
    await processTxHash(r.hash);
    console.log("Indexed into the database.");
  } catch (e) {
    console.log(`Not indexed now (${(e as Error).message}); the indexer picks it up from the chain.`);
  }
  return { hash: r.hash };
}

if (/cli[\\/]admin\.(ts|js)$/.test(process.argv[1] ?? "")) {
  try {
    await main(process.argv.slice(2));
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      const known = e instanceof OpError || e instanceof NetworkError || e instanceof KeySourceError || e instanceof PauseRuleError;
      const decoded = known ? null : decodeSolversError(e);
      const msg = known ? (e as Error).message : decoded && decoded.name !== "Unknown" ? `${decoded.name}: ${decoded.message}` : ((e as Error)?.message ?? String(e));
      console.error(`Failed: ${msg}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
  process.exit(process.exitCode ?? 0);
}
