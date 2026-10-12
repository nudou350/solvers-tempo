# AGENTS.md

Rules for any coding agent working in this repository. Read `CLAUDE.md` for the map of the codebase and
`docs/migration/progress.md` for where the migration stands.

## Contracts (`contracts/`, Solidity + Foundry, Tempo)

- Tempo has **no native token**: `msg.value`, `CALLVALUE`, `BALANCE` and `SELFBALANCE` are always 0. Never write `payable`
  functions, never read `msg.value`, never rely on `address.balance`. All money is a TIP-20 stablecoin (6 decimals).
- **Checks-effects-interactions** in every function; external calls (token transfers, `_safeMint`, satellite calls) come last.
  Every function that moves tokens is `nonReentrant` (OZ `ReentrancyGuardTransient`, stateless; TSTORE works on Tempo).
- **No `tx.origin`**, no `selfdestruct`, no `delegatecall` outside the OZ UUPS machinery.
- Token movement through `SafeERC20`. Every deposit into a contract-held vault (escrow, stake, deferred payouts) is
  **balance-diff checked** and reverts on fee-on-transfer tokens. TIP-20 transfers to a TIP-20 address revert; TIP-403 and
  receive policies can block deliveries, so payer→recipient pushes fall back to `deferred[recipient]` + `claim()` (D5).
- **Custom errors only** (no revert strings, no `require(cond, "text")`) in `contracts/src` (scripts may use `require`).
  A new custom error also needs its message in `packages/chain/src/errors.ts` and its `contract.<Name>` text in
  `apps/web/messages/{en,pt}/errors.json`. Every state change emits an event that carries what the indexer needs; the indexer
  never parses token deltas and re-reads state by id.
- Every external function and custom error of the six ABIs must be referenced by a test (`test/AbiCoverage.t.sol`).
- Access control lives in `SolversRegistry` (OZ `AccessControlDefaultAdminRules`); satellites check `registry.hasRole`. Every
  gated function has a test for the allowed role and for a denied caller (access-control matrix), and every pause bit has a test.
- **No unbounded loops** over user-controlled arrays (milestones are capped at 5; agent enumeration is index-based).
- **Gas awareness**: a new storage slot costs 250,000 gas on Tempo (not 20,000). Pack structs, prefer warm writes, count new slots
  per path and keep `forge snapshot` and the gas table in `docs/migration/phase-2.md` current.
- **Upgradeability (UUPS)**: one ERC-7201 namespaced storage struct per contract, append-only (also at the tail of nested structs),
  never retype or delete a field (rename it `__deprecated_x`), enums append-only, migrations via `reinitializer(n)`.
  Implementation constructors call `_disableInitializers()`. After any storage change run
  `node script/check-layouts.mjs`; only after it passes (appends only) regenerate with `--write` and commit
  `contracts/storage-layouts/*.json`. `SolversEscrow.Milestone` lives in a fixed `Milestone[5]` array and must NEVER
  grow (it would shift milestones 1-4): put new per-milestone data in a separate mapping.
- Amounts are `uint96`/`uint256` base units, times `uint40`, bps `uint16`. Fee and royalty math floors exactly like
  `SolversMath.feeSplit` / `royaltySplit`, with the TypeScript mirrors in `packages/shared` tested against the same vectors.
- Network fees are never part of any split; every purchase is `>= minPrice`; a transfer never frees a cap slot; the cap only
  rises; evals are version-scoped (`docs/economics.md`, `docs/royalties.md`, `docs/license-cap.md`).
- Never change a deployed contract except through a validated UUPS upgrade (`script/Upgrade.s.sol`, `docs/deploy-runbook.md`
  §4.6), and never send anything to mainnet without the owner.
- Run `forge fmt`, `forge build --sizes` (each contract < 24,576 bytes), `forge test`, `forge snapshot --check` and
  `node script/check-layouts.mjs` before committing contract changes; then regenerate the client.

## TypeScript (viem, server, web)

- Use **viem** (`viem`, `viem/tempo`, `viem/chains`) for every chain interaction; no other EVM library.
- Never hand-edit `packages/contracts-client/src/generated`: regenerate with `pnpm --filter @solvers/contracts-client generate`
  after the contracts change.
- Addresses: one zod `Address` type; stored lowercase in the DB, displayed checksummed (`getAddress`).
- Money is `bigint` in token base units end to end; no float math on amounts (format only at the edge).
- Transactions from browsers and agents are Tempo type `0x76` batches with `feePayer: true` through the platform relay;
  server-sent transactions use the in-process fee payer on their own 2D nonce lane.
- Keys and `.env*` never enter git; dev keys live in `apps/server/.keys` (gitignored).
- Tests use `node:test`; DB tests (`*.db.test.ts`) only against a disposable Postgres (`TEST_DATABASE_URL`, container
  `solvers-tempo-pg` on port 5546). On the development machine never point anything at `127.0.0.1:5433`, 5543 or 5544
  (other projects' databases with real data).

## Web (`apps/web`)

Next.js 16 differs from training data: read `apps/web/AGENTS.md` and `apps/web/node_modules/next/dist/docs/` before writing web
code. Keep the `en` and `pt` message files complete (`node apps/web/scripts/check-messages.mjs`).
