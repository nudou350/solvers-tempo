// Pure guards of the admin CLIs (`cli:admin`, `cli:approve`, `cli:suspend`): network, key source and pause rules.
// No network or env: tested in test/admin-guard.test.ts.

import { ALL_PAUSE_FLAGS, PAUSE_FLAGS } from "@solvers/shared";

export const CHAIN_IDS = { mainnet: 4217, moderato: 42431, local: 31337 } as const;

/** Names accepted by `--allow-network`: they must equal the network actually detected. */
export type NetworkName = "local" | "moderato" | "mainnet" | "unknown";

export function networkName(chainId: number): NetworkName {
  return chainId === CHAIN_IDS.local ? "local" : chainId === CHAIN_IDS.moderato ? "moderato" : chainId === CHAIN_IDS.mainnet ? "mainnet" : "unknown";
}

export class NetworkError extends Error {}

/**
 * The RPC must be on CHAIN_ID; the local chain and Moderato pass by default. Mainnet (or an unknown chain) only with
 * `--allow-network <name>` EQUAL to the detected network, so the override is deliberate and never valid for the wrong
 * network. Returns a warning when the override was used.
 */
export function assertNetwork(rpcChainId: number, envChainId: number, allow: string | null): { network: NetworkName; warning: string | null } {
  if (rpcChainId !== envChainId) throw new NetworkError(`the RPC is on chain ${rpcChainId}, but CHAIN_ID is ${envChainId}. Aborting.`);
  const network = networkName(rpcChainId);
  if (network === "local" || network === "moderato") return { network, warning: null };
  if (allow === network) return { network, warning: `WARNING: network ${network} (chain ${rpcChainId}) allowed by --allow-network.` };
  throw new NetworkError(
    `the RPC is on the "${network}" network (chain ${rpcChainId}). Aborting${allow ? ` (--allow-network ${allow} does not match the detected network)` : ""}. ` +
      `If this is on purpose, repeat with --allow-network ${network}.`,
  );
}

export class KeySourceError extends Error {}

export type KeySource = { source: "key-file"; path: string } | { source: "env" } | { source: "none" };

/**
 * Where the signing key of an admin command comes from. On mainnet the server never holds ADMIN_PRIVATE_KEY (env.ts refuses
 * it) and the CLI refuses any key from the environment: the key must come from `--key-file`, given explicitly. Off
 * mainnet, `--key-file` wins and ADMIN_PRIVATE_KEY is the default. `none` = no key here (only a dry-run can proceed).
 */
export function adminKeySource(i: { network: NetworkName; keyFile: string | null; envKeySet: boolean }): KeySource {
  if (i.network === "mainnet" || i.network === "unknown") {
    if (i.envKeySet) throw new KeySourceError("ADMIN_PRIVATE_KEY must not be set on mainnet: pass the admin key with --key-file <file> instead");
    return i.keyFile ? { source: "key-file", path: i.keyFile } : { source: "none" };
  }
  if (i.keyFile) return { source: "key-file", path: i.keyFile };
  return i.envKeySet ? { source: "env" } : { source: "none" };
}

export class PauseRuleError extends Error {}

const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Who signs `set-pause` and whether the change is allowed (mirrors `SolversRegistry.setPause`: the admin sets any valid
 * combination; a guardian (GUARDIAN_ROLE) only ADDS bits and never adds TRANSFERS). `keyAddress` null = no key on this
 * computer (admin dry-run). Refuses before simulating/sending.
 */
export function decidePauseSigner(input: {
  current: number;
  next: number;
  admin: string;
  keyAddress: string | null;
  /** The key holds GUARDIAN_ROLE. */
  keyIsGuardian: boolean;
}): { role: "admin" | "guardian"; unpausing: boolean } {
  const { current, next, admin, keyAddress } = input;
  if (!Number.isInteger(next) || next < 0 || (next & ~ALL_PAUSE_FLAGS) !== 0) throw new PauseRuleError(`invalid pause flags: ${next}`);
  if (keyAddress && !same(keyAddress, admin) && !input.keyIsGuardian) {
    throw new PauseRuleError(`the key belongs to ${keyAddress}, which is neither the admin (${admin}) nor a guardian`);
  }
  const role = keyAddress && !same(keyAddress, admin) ? "guardian" : "admin";
  const unpausing = (next & current) !== current;
  if (role === "guardian" && unpausing) throw new PauseRuleError(`a guardian can only ADD pause bits; to release, sign with the admin key (${admin})`);
  if (role === "guardian" && (next & ~current & PAUSE_FLAGS.TRANSFERS) !== 0) {
    throw new PauseRuleError("the TRANSFERS bit is an admin-only emergency switch: a guardian cannot set it");
  }
  if (next === current) throw new PauseRuleError("the pause is already at this value: nothing to do");
  return { role, unpausing };
}

export class RoleGrantError extends Error {}

/** What `grant-role` tells the operator about the RELAY check (printed with every grant). */
export const RELAY_CHECK_NOTE =
  "RELAY check: only THIS environment's RELAY key (RELAY_PRIVATE_KEY) is recognized; a RELAY key of another deployment or a rotated one is not. Never grant a role to a fee-payer key.";

/**
 * D3/D11: the RELAY key pays fees only and must never hold a contract role, so `grant-role` refuses ANY role to the
 * address configured as RELAY here. The check is env-local (see RELAY_CHECK_NOTE). Exception: on the local chain RELAY
 * may reuse the PLATFORM key (env.ts allows it only there), and then PLATFORM's own roles (platform, usage) pass.
 */
export function assertRoleGrantAllowed(i: { role: string; account: string; relay: string | null; platform: string | null; chainId: number }): void {
  if (!same(i.account, i.relay)) return;
  const relayIsPlatform = i.chainId === CHAIN_IDS.local && same(i.relay, i.platform);
  if (relayIsPlatform && (i.role === "platform" || i.role === "usage")) return;
  throw new RoleGrantError(`${i.account} is this environment's RELAY key: it pays fees only and must never hold a contract role (D3)`);
}

/** Mirrors `SolversStaking.SLASH_DELAY`, `SLASH_EXPIRY_GRACE`, the stake exit extension and its maximum. */
export const SLASH_DELAY_SECS = 72 * 3600;
export const STAKE_EXIT_EXTENSION_SECS = 30 * 86_400;
export const MAX_STAKE_EXIT_EXTENSIONS = 2;
/** After `proposedAt + 72 h + 14 days` the contract refuses `executeSlash` (`SlashExpired`) and the creator may cancel. */
export const SLASH_EXPIRY_GRACE_SECS = 14 * 86_400;

/** How long until `executeSlash` passes (seconds, 0 = already), and the text "1 d 3 h 20 min". */
export function slashWait(proposedAt: bigint | number, nowSecs: number): { remainingSecs: number; executableAt: number; expiresAt: number; expired: boolean; text: string } {
  const executableAt = Number(proposedAt) + SLASH_DELAY_SECS;
  const expiresAt = executableAt + SLASH_EXPIRY_GRACE_SECS;
  const expired = nowSecs > expiresAt;
  const remainingSecs = Math.max(0, executableAt - nowSecs);
  if (remainingSecs === 0) {
    return { remainingSecs, executableAt, expiresAt, expired, text: expired ? "the proposal EXPIRED (72 h + 14 days): it can no longer be executed, only cancelled" : "the 72 h wait is over" };
  }
  const d = Math.floor(remainingSecs / 86_400);
  const h = Math.floor((remainingSecs % 86_400) / 3600);
  const m = Math.ceil((remainingSecs % 3600) / 60);
  const carry = m === 60 ? { h: h + 1, m: 0 } : { h, m };
  const parts = [d ? `${d} d` : null, carry.h ? `${carry.h} h` : null, carry.m ? `${carry.m} min` : null].filter(Boolean);
  return { remainingSecs, executableAt, expiresAt, expired, text: `${parts.join(" ")} left` };
}

/**
 * When a `changeDefaultAdminDelay(next)` scheduled now takes effect (mirrors OpenZeppelin
 * `AccessControlDefaultAdminRules._delayChangeWait`): an increase waits min(next, increaseWait) (5 days by default, so a
 * typo such as milliseconds can be rolled back); a decrease waits current - next, so a transfer can never complete faster
 * than the delay in force when the change was scheduled.
 */
export function adminDelayChangeAt(i: { current: number; next: number; increaseWait: number; nowSecs: number }): number {
  const wait = i.next > i.current ? Math.min(i.next, i.increaseWait) : i.current - i.next;
  return i.nowSecs + wait;
}

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1); what `proxiableUUID()` must return. */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** `deployedBytecode` of a Foundry artifact (`contracts/out/<Name>.sol/<Name>.json`). */
export type RuntimeArtifact = { object: string; immutableReferences?: Record<string, readonly { start: number; length: number }[]> };

/**
 * Runtime code reduced to what the source decides: the immutable slots zeroed (they hold per-deployment values, such as
 * UUPSUpgradeable's `__self`) and the trailing CBOR metadata removed (its hash changes with comments and paths, not
 * with behaviour). Hex without 0x, lowercase.
 */
function comparableRuntimeCode(code: string, immutables: readonly { start: number; length: number }[]): string {
  const bytes = Buffer.from(code.replace(/^0x/i, ""), "hex");
  for (const r of immutables) bytes.fill(0, r.start, r.start + r.length);
  let end = bytes.length;
  if (end >= 2) {
    const cborLen = bytes.readUInt16BE(end - 2);
    const start = end - 2 - cborLen;
    // A CBOR map header (0xa1-0xa5) where solc puts the metadata; otherwise compare the whole code.
    if (cborLen > 0 && start >= 0 && bytes[start]! >= 0xa1 && bytes[start]! <= 0xa5) end = start;
  }
  return bytes.subarray(0, end).toString("hex");
}

/**
 * Is `onchain` (eth_getCode of the new implementation) the runtime code of `artifact`? Used by `cli:admin upgrade` so a
 * proxy is never pointed at another contract's implementation (for example the License proxy at a Credits
 * implementation: both answer the UUPS proxiableUUID). Returns null when it matches, otherwise the reason.
 */
export function runtimeCodeMismatch(onchain: string, artifact: RuntimeArtifact): string | null {
  const live = onchain.replace(/^0x/i, "").toLowerCase();
  const built = artifact.object.replace(/^0x/i, "").toLowerCase();
  if (!built) return "the local artifact has no runtime code (abstract contract or interface)";
  if (live.length !== built.length) return `its runtime code is ${live.length / 2} bytes, the local build's is ${built.length / 2} bytes`;
  const refs = Object.values(artifact.immutableReferences ?? {}).flat();
  return comparableRuntimeCode(live, refs) === comparableRuntimeCode(built, refs) ? null : "its runtime code differs from the local build";
}
