// Parsing (pure, no network and no env) of the `cli:admin` arguments. Separate from admin.ts so it is testable.

import { createHash } from "node:crypto";
import { ALL_PAUSE_FLAGS, PAUSE_FLAGS, isAddress, toUnits } from "@solvers/shared";

export type RoleName = "platform" | "usage" | "verifier" | "guardian";
export const ROLE_NAMES: readonly RoleName[] = ["platform", "usage", "verifier", "guardian"];

/** Contracts that hold deferred payouts and expose `sweepStray` (SolversPayouts). */
export type PayoutContract = "license" | "credits" | "escrow" | "staking";
export const PAYOUT_CONTRACTS: readonly PayoutContract[] = ["license", "credits", "escrow", "staking"];

/** The six UUPS proxies of the deployment (all upgraded by the Registry's default admin, D2). */
export type UpgradeableContract = "registry" | "license" | "credits" | "reviews" | "escrow" | "staking";
export const UPGRADEABLE_CONTRACTS: readonly UpgradeableContract[] = ["registry", "license", "credits", "reviews", "escrow", "staking"];

/** `defaultAdminDelay` is a uint48 on-chain. */
export const MAX_ADMIN_DELAY_SECS = 2 ** 48 - 1;

/** Partial `setConfig`: unset fields keep the current on-chain value. Amounts in token base units. */
export type ConfigChange = { treasury?: string; feeBps?: number; platformRoyaltyBps?: number; minStake?: bigint; minPrice?: bigint };

export type AdminCommand =
  | { cmd: "propose"; newAdmin: string }
  | { cmd: "accept" }
  | { cmd: "cancel" }
  | { cmd: "set-config"; change: ConfigChange }
  | { cmd: "set-pause"; flags: number }
  | { cmd: "grant-role"; role: RoleName; account: string }
  | { cmd: "revoke-role"; role: RoleName; account: string }
  | { cmd: "propose-slash"; slug: string; amount: bigint; reason: string }
  | { cmd: "execute-slash"; slug: string }
  | { cmd: "cancel-slash"; slug: string }
  | { cmd: "extend-stake-exit"; slug: string; reason: string }
  | { cmd: "resolve-dispute"; escrowId: bigint; index: number; refund: boolean }
  | { cmd: "set-base-uri"; uri: string }
  | { cmd: "sweep-stray"; contract: PayoutContract; to: string }
  | { cmd: "admin-delay"; seconds: number }
  | { cmd: "admin-delay-rollback" }
  | { cmd: "upgrade"; contract: UpgradeableContract; implementation: string; data: `0x${string}` };

export type AdminArgs = {
  command: AdminCommand;
  /** Without --yes it is a dry-run: nothing is sent. */
  yes: boolean;
  /** Key file of the signer (accept: the NEW admin; set-pause: admin or guardian; others: the admin). Required on mainnet. */
  keyFile: string | null;
  /** Deliberately allows mainnet (must be the name of the detected network). */
  allowNetwork: string | null;
};

export class UsageError extends Error {}

export const USAGE = `usage: pnpm --filter @solvers/server cli:admin <command> [--yes] [--key-file <file>] [--allow-network <name>]

  propose <new-admin>                  begin the 2-step default admin transfer (current admin signs)
  accept                               the new admin accepts (signs with the NEW admin's key: --key-file)
  cancel                               the current admin cancels the pending transfer
  set-config key=value ...             treasury=<address> fee-bps=<n> platform-royalty-bps=<n> min-stake=<amount> min-price=<amount>
                                       (any subset; the rest keeps the on-chain value; amounts in token units, e.g. 5 or 12.5)
  set-pause <flags>                    none | entries | payments | transfers | all, a comma list, or 0..7.
                                       The admin sets anything; a guardian only adds bits and never adds transfers
  grant-role <role> <address>          role = platform | usage | verifier | guardian
  revoke-role <role> <address>
  propose-slash <slug> <amount> <reason>   propose confiscating stake (executable after 72 h; the Solver is suspended)
  execute-slash <slug>                 execute after 72 h (the dry-run shows how long is left)
  cancel-slash <slug>                  withdraw the proposal (the Solver stays suspended until approveAgent)
  extend-stake-exit <slug> <reason>    +30 days on the stake exit wait (at most 2 times)
  resolve-dispute <escrowId> <index> <refund|release>   decide a disputed guarantee step
  set-base-uri <uri>                   license metadata base URI (tokenURI = base + tokenId)
  sweep-stray <license|credits|escrow|staking> <to>     send stray tokens (balance - locked - deferred) to <to>
  admin-delay <seconds>                schedule a new default admin transfer delay on the Registry (172800 = 48 h)
  admin-delay-rollback                 cancel a scheduled delay change that has not taken effect yet
  upgrade <contract> <new-impl> [--call <hex>]   upgradeToAndCall on the proxy (registry | license | credits | reviews |
                                       escrow | staking); <new-impl> must come from contracts/script/Upgrade.s.sol
                                       (validate, then UPGRADE_MODE=prepare); --call = calldata run after the upgrade

Without --yes it is a dry-run: prints who signs, the calls and the simulation result, and sends nothing.
The fee is always sponsored by the RELAY key (D20): the admin key holds no tokens. Keys are never printed.
Key: --key-file <file>, or ADMIN_PRIVATE_KEY off mainnet; on mainnet only --key-file is accepted.
Network: the local chain and Moderato pass; mainnet only with --allow-network mainnet. reason hash = sha256 of the text.`;

/** Token amount as decimal text ("5", "12.5", "0.000001"): up to `decimals` places, greater than zero, no floats. */
export function parseTokenAmount(text: string, decimals = 6, opts: { allowZero?: boolean } = {}): bigint {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(t)) throw new UsageError(`invalid amount: "${text}" (use numbers such as 5 or 12.5, up to ${decimals} places)`);
  let units: bigint;
  try {
    units = toUnits(t, decimals);
  } catch {
    throw new UsageError(`invalid amount: "${text}" (at most ${decimals} decimal places)`);
  }
  if (units <= 0n && !opts.allowZero) throw new UsageError("the amount must be greater than zero");
  return units;
}

function addressArg(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}`);
  if (!isAddress(value)) throw new UsageError(`invalid ${what}: "${value}" is not an address`);
  return value.toLowerCase();
}

function bpsArg(value: string, what: string, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) > max) throw new UsageError(`invalid ${what}: "${value}" (integer bps from 0 to ${max})`);
  return Number(value);
}

const PAUSE_NAMES: Record<string, number> = {
  none: 0,
  entries: PAUSE_FLAGS.ENTRIES,
  payments: PAUSE_FLAGS.PAYMENTS,
  transfers: PAUSE_FLAGS.TRANSFERS,
  all: ALL_PAUSE_FLAGS,
};

/** `none` | `entries` | `payments` | `transfers` | `all`, a comma list of them, or a number 0..7. Never a bit outside the mask. */
export function parsePauseFlags(text: string | undefined): number {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) throw new UsageError("missing the pause value: none | entries | payments | transfers | all");
  if (/^\d+$/.test(t)) {
    if (Number(t) <= ALL_PAUSE_FLAGS) return Number(t);
    throw new UsageError(`invalid pause value: "${text}" (0 to ${ALL_PAUSE_FLAGS})`);
  }
  let flags = 0;
  for (const part of t.split(",").map((p) => p.trim())) {
    const v = PAUSE_NAMES[part];
    if (v === undefined) throw new UsageError(`invalid pause value: "${text}" (use none, entries, payments, transfers, all, or 0 to ${ALL_PAUSE_FLAGS})`);
    flags |= v;
  }
  return flags;
}

/** On-chain reason hash: sha256 of the reason (UTF-8, trimmed), as bytes32. Auditors recompute it from the same text. */
export function reasonHashOf(reason: string): `0x${string}` {
  const text = reason.trim();
  if (!text) throw new UsageError("missing the reason (its sha256 becomes the on-chain reason hash)");
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** `set-config` pairs (`key=value`). */
export function parseConfigChange(pairs: readonly string[], decimals = 6): ConfigChange {
  if (pairs.length === 0) throw new UsageError("set-config needs at least one key=value (treasury, fee-bps, platform-royalty-bps, min-stake, min-price)");
  const change: ConfigChange = {};
  const seen = new Set<string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (seen.has(key)) throw new UsageError(`${key} given twice`);
    seen.add(key);
    switch (key) {
      case "treasury":
        change.treasury = addressArg(value, "treasury");
        break;
      case "fee-bps":
        change.feeBps = bpsArg(value, "fee-bps", 2000);
        break;
      case "platform-royalty-bps":
        change.platformRoyaltyBps = bpsArg(value, "platform-royalty-bps", 2500);
        break;
      case "min-stake":
        change.minStake = parseTokenAmount(value, decimals, { allowZero: true });
        break;
      case "min-price":
        change.minPrice = parseTokenAmount(value, decimals);
        break;
      default:
        throw new UsageError(`unknown config key: ${key}`);
    }
  }
  return change;
}

/** `--call` calldata: 0x-prefixed whole bytes ("0x" = none). Lowercased. */
export function parseCallData(text: string): `0x${string}` {
  const t = text.trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(t)) throw new UsageError(`invalid --call data: "${text}" (0x followed by whole bytes in hex)`);
  return t.toLowerCase() as `0x${string}`;
}

export function parseAdminArgs(argv: readonly string[], decimals = 6): AdminArgs {
  let yes = false;
  let keyFile: string | null = null;
  let allowNetwork: string | null = null;
  let callData: `0x${string}` | null = null;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes") yes = true;
    else if (a === "--call") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError("--call needs the calldata in hex (0x...)");
      if (callData !== null) throw new UsageError("--call given twice");
      callData = parseCallData(v);
    }
    else if (a === "--key-file") {
      keyFile = argv[++i] ?? null;
      if (!keyFile || keyFile.startsWith("--")) throw new UsageError("--key-file needs the path of a key file");
    } else if (a === "--allow-network") {
      allowNetwork = argv[++i] ?? null;
      if (!allowNetwork || allowNetwork.startsWith("--")) throw new UsageError("--allow-network needs the network name (mainnet)");
    } else if (a.startsWith("--")) throw new UsageError(`unknown option: ${a}`);
    else pos.push(a);
  }
  const [name, ...rest] = pos;
  if (callData !== null && name !== "upgrade") throw new UsageError("--call is only valid with upgrade");
  const expect = (n: number, shape: string) => {
    if (rest.length !== n) throw new UsageError(`usage: ${name} ${shape}`.trim());
  };
  const opts = { yes, keyFile, allowNetwork };
  const roleArg = (v: string | undefined): RoleName => {
    const r = (v ?? "").toLowerCase() as RoleName;
    if (!ROLE_NAMES.includes(r)) throw new UsageError(`unknown role: "${v ?? ""}" (${ROLE_NAMES.join(" | ")})`);
    return r;
  };
  switch (name) {
    case "propose":
      expect(1, "<new-admin>");
      return { command: { cmd: "propose", newAdmin: addressArg(rest[0], "new admin") }, ...opts };
    case "accept":
      expect(0, "");
      return { command: { cmd: "accept" }, ...opts };
    case "cancel":
      expect(0, "");
      return { command: { cmd: "cancel" }, ...opts };
    case "set-config":
      return { command: { cmd: "set-config", change: parseConfigChange(rest, decimals) }, ...opts };
    case "set-pause":
      expect(1, "<none|entries|payments|transfers|all>");
      return { command: { cmd: "set-pause", flags: parsePauseFlags(rest[0]) }, ...opts };
    case "grant-role":
    case "revoke-role":
      expect(2, "<role> <address>");
      return { command: { cmd: name, role: roleArg(rest[0]), account: addressArg(rest[1], "account") }, ...opts };
    case "propose-slash":
      expect(3, "<slug> <amount> <reason>");
      reasonHashOf(rest[2]!);
      return { command: { cmd: "propose-slash", slug: rest[0]!, amount: parseTokenAmount(rest[1]!, decimals), reason: rest[2]!.trim() }, ...opts };
    case "execute-slash":
    case "cancel-slash":
      expect(1, "<slug>");
      return { command: { cmd: name, slug: rest[0]! }, ...opts };
    case "extend-stake-exit":
      expect(2, "<slug> <reason>");
      reasonHashOf(rest[1]!);
      return { command: { cmd: "extend-stake-exit", slug: rest[0]!, reason: rest[1]!.trim() }, ...opts };
    case "resolve-dispute": {
      expect(3, "<escrowId> <index> <refund|release>");
      if (!/^\d+$/.test(rest[0]!) || BigInt(rest[0]!) === 0n) throw new UsageError(`invalid escrow id: "${rest[0]}"`);
      if (!/^[0-4]$/.test(rest[1]!)) throw new UsageError(`invalid step index: "${rest[1]}" (0 to 4)`);
      const verdict = rest[2]!.toLowerCase();
      if (verdict !== "refund" && verdict !== "release") throw new UsageError(`the decision must be refund or release, got "${rest[2]}"`);
      return { command: { cmd: "resolve-dispute", escrowId: BigInt(rest[0]!), index: Number(rest[1]), refund: verdict === "refund" }, ...opts };
    }
    case "set-base-uri": {
      expect(1, "<uri>");
      const uri = rest[0]!.trim();
      if (!/^https?:\/\/\S+$/.test(uri) || uri.length > 200) throw new UsageError(`invalid base URI: "${uri}" (http(s) URL, at most 200 characters)`);
      return { command: { cmd: "set-base-uri", uri }, ...opts };
    }
    case "sweep-stray": {
      expect(2, "<license|credits|escrow|staking> <to>");
      const contract = rest[0]!.toLowerCase() as PayoutContract;
      if (!PAYOUT_CONTRACTS.includes(contract)) throw new UsageError(`unknown contract: "${rest[0]}" (${PAYOUT_CONTRACTS.join(" | ")})`);
      return { command: { cmd: "sweep-stray", contract, to: addressArg(rest[1], "recipient") }, ...opts };
    }
    case "admin-delay": {
      expect(1, "<seconds>");
      const t = rest[0]!;
      if (!/^\d+$/.test(t) || Number(t) > MAX_ADMIN_DELAY_SECS) throw new UsageError(`invalid delay: "${t}" (whole seconds, e.g. 172800 for 48 h)`);
      return { command: { cmd: "admin-delay", seconds: Number(t) }, ...opts };
    }
    case "admin-delay-rollback":
      expect(0, "");
      return { command: { cmd: "admin-delay-rollback" }, ...opts };
    case "upgrade": {
      expect(2, "<registry|license|credits|reviews|escrow|staking> <new-implementation> [--call <hex>]");
      const contract = rest[0]!.toLowerCase() as UpgradeableContract;
      if (!UPGRADEABLE_CONTRACTS.includes(contract)) throw new UsageError(`unknown contract: "${rest[0]}" (${UPGRADEABLE_CONTRACTS.join(" | ")})`);
      return { command: { cmd: "upgrade", contract, implementation: addressArg(rest[1], "new implementation"), data: callData ?? "0x" }, ...opts };
    }
    default:
      throw new UsageError(name ? `unknown command: ${name}` : "missing the command");
  }
}
