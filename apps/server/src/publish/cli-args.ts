// Arguments of `cli:approve` and `cli:suspend` (pure, no network or env: tested in test/publish-rules.test.ts).

export class CliUsageError extends Error {}

export const APPROVE_USAGE = `usage: pnpm --filter @solvers/server cli:approve <slug|submissionId> [--dry-run] [--key-file <file>] [--allow-network <name>]

  Signs approveAgent (the Registry's default admin) for the NEW Solver the creator already registered, then finishes the
  publication. Only approves when the on-chain agent matches the version approved on the site (hash, version, price).
  The fee is sponsored by the RELAY key (the admin key holds no tokens). --dry-run only shows what it would do.
  Key: --key-file <file>, or ADMIN_PRIVATE_KEY off mainnet (on mainnet only --key-file is accepted).
  Runs on the local chain and Moderato; mainnet only with --allow-network mainnet (must match the RPC's chain).`;

export type ApproveArgs = { ref: string; dryRun: boolean; keyFile: string | null; allowNetwork: string | null };

function valueOf(argv: readonly string[], i: number, flag: string, what: string): string {
  const v = argv[i];
  if (!v || v.startsWith("--")) throw new CliUsageError(`${flag} needs ${what}`);
  return v;
}

export function parseApproveArgs(argv: readonly string[]): ApproveArgs {
  const rest: string[] = [];
  let dryRun = false;
  let keyFile: string | null = null;
  let allowNetwork: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--key-file") keyFile = valueOf(argv, ++i, a, "the path of a key file");
    else if (a === "--allow-network") allowNetwork = valueOf(argv, ++i, a, "the network name");
    else if (a.startsWith("--")) throw new CliUsageError(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new CliUsageError("pass one slug or submission id");
  return { ref: rest[0]!, dryRun, keyFile, allowNetwork };
}

export const SUSPEND_USAGE = `usage: pnpm --filter @solvers/server cli:suspend <slug> [--resume] [--reason "<text>"] [--key-file <file>] [--allow-network <name>]

  Suspends the Solver: platform_status = suspended (drops open sessions, the store and sales at once) and suspendAgent
  on-chain (default admin key, fee sponsored by RELAY), with an audit row in package_reviews. --resume does the reverse
  (approveAgent on-chain and platform_status = active). Same key and network rules as cli:approve.`;

export type SuspendArgs = { ref: string; resume: boolean; reason: string | null; keyFile: string | null; allowNetwork: string | null };

export function parseSuspendArgs(argv: readonly string[]): SuspendArgs {
  const rest: string[] = [];
  let resume = false;
  let reason: string | null = null;
  let keyFile: string | null = null;
  let allowNetwork: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--resume") resume = true;
    else if (a === "--reason") reason = valueOf(argv, ++i, a, "the reason in quotes");
    else if (a === "--key-file") keyFile = valueOf(argv, ++i, a, "the path of a key file");
    else if (a === "--allow-network") allowNetwork = valueOf(argv, ++i, a, "the network name");
    else if (a.startsWith("--")) throw new CliUsageError(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new CliUsageError("pass the Solver's slug (or id)");
  return { ref: rest[0]!, resume, reason, keyFile, allowNetwork };
}
