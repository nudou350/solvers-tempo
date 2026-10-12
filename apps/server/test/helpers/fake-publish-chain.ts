import type { Call } from "@solvers/chain";
import { agentIdToBytes32, type TxResponse } from "@solvers/shared";
import type { AgentChainState } from "../../src/indexer/mirror.js";
import { checkCreatorTx, type ApprovedRecord, type ChainAgentState, type OnchainStatus, type RegistryEvent, type TouchKind } from "../../src/publish/approval-rules.js";
import type { PublishChain, PublishConfig } from "../../src/publish/chain-port.js";

// In-memory chain for the publication DB tests (the anvil test covers the real one): keeps each agent in memory, lets
// the test "land" the creator's and the admin's transactions (as Registry events per tx hash) and mirrors into the
// database with the indexer's own `mirrorAgentAccount`, so the approved-version vs chain check really runs.

type Account = { creator: string; version: string; versionHash: string; price: bigint; royaltyBps: number; status: OnchainStatus; index?: number };

const STATUS_CODE: Record<OnchainStatus, number> = { pending: 0, active: 1, suspended: 2, retired: 3 };
export const FAKE_ADMIN = "0x00000000000000000000000000000000000000ad";
const ZERO_HASH = `0x${"0".repeat(64)}` as const;

export class FakeChain implements PublishChain {
  accounts = new Map<string, Account>();
  /** tx hash -> what it did (sender + Registry events). */
  txs = new Map<string, { agentId: string; from: string; events: RegistryEvent[] }>();
  balances = new Map<string, bigint>();
  cfg: PublishConfig = { minStake: 5_000_000n, minPrice: 5_000_000n, platformRoyaltyBps: 500 };
  admin: string | null = FAKE_ADMIN;
  onchainAdminAddress = FAKE_ADMIN;
  failSuspend = false;
  /** Refusal returned by `simulate` (null = ok). */
  simulateRefusal: { name: string; message: string } | null = null;
  /** What each `build*` received (proof that price/hash come from the server). */
  built: { kind: string; wallet: string; agentId: string; approved: ApprovedRecord; maxSupply?: number }[] = [];
  calls: string[] = [];
  private n = 0;
  /** Registry index of the next registered agent (high, so it never collides with other test rows: unique column). */
  nextIndex = 900_000 + Math.floor(Math.random() * 90_000);

  constructor(private readonly mirror: (s: AgentChainState) => Promise<unknown>) {}

  private hash(): string {
    return `0x${(++this.n).toString(16).padStart(64, "0")}`;
  }

  async fetchAgentState(agentId: string): Promise<ChainAgentState> {
    const a = this.accounts.get(agentId);
    return a ? { exists: true, creator: a.creator, version: a.version, versionHash: a.versionHash, price: a.price, status: a.status, royaltyBps: a.royaltyBps, totalSales: 0 } : { exists: false };
  }
  async config() {
    return this.cfg;
  }
  async tokenBalance(wallet: string) {
    return this.balances.get(wallet.toLowerCase()) ?? 100_000_000n;
  }
  async simulate(_wallet: string, _calls: readonly Call[]) {
    return this.simulateRefusal;
  }
  private tx(kind: string): TxResponse {
    return { calls: [{ to: "0x00000000000000000000000000000000000000c1", data: `0x${Buffer.from(kind).toString("hex")}` }], feePayer: true, chainId: 31337 };
  }
  async buildRegister(wallet: string, agentId: string, approved: ApprovedRecord, opts: { maxSupply?: number } = {}) {
    this.built.push({ kind: "register-agent", wallet, agentId, approved, ...(opts.maxSupply ? { maxSupply: opts.maxSupply } : {}) });
    return this.tx("register");
  }
  async buildUpdateVersion(wallet: string, agentId: string, approved: ApprovedRecord) {
    this.built.push({ kind: "update-version", wallet, agentId, approved });
    return this.tx("update-version");
  }
  async buildUpdatePricing(wallet: string, agentId: string, approved: ApprovedRecord) {
    this.built.push({ kind: "update-pricing", wallet, agentId, approved });
    return this.tx("update-pricing");
  }
  async verifyCreatorTx(txHash: string, agentId: string, expected: { creatorWallet: string; approved: ApprovedRecord; kind?: TouchKind }) {
    const t = this.txs.get(txHash.toLowerCase());
    if (!t) return { ok: false as const, reason: "transaction not found" };
    return checkCreatorTx({ events: t.events, from: t.from, success: true }, { agentId, ...expected });
  }
  async adminAddress() {
    return this.admin;
  }
  async onchainAdmin() {
    return this.onchainAdminAddress;
  }
  async approveAgent(agentId: string) {
    this.calls.push(`approve:${agentId}`);
    this.mustExist(agentId).status = "active";
    return this.record(agentId, FAKE_ADMIN, [{ name: "AgentStatusChanged", args: { agentId: agentIdToBytes32(agentId), status: 1 } }]);
  }
  async suspendAgent(agentId: string) {
    this.calls.push(`suspend:${agentId}`);
    if (this.failSuspend) throw new Error("RPC down");
    this.mustExist(agentId).status = "suspended";
    return this.record(agentId, FAKE_ADMIN, [{ name: "AgentStatusChanged", args: { agentId: agentIdToBytes32(agentId), status: 2 } }]);
  }
  async syncAgent(agentId: string) {
    const a = this.accounts.get(agentId);
    if (a) await this.mirror(this.asState(agentId, a));
  }
  async indexTx(txHash: string) {
    const t = this.txs.get(txHash.toLowerCase());
    if (t) await this.syncAgent(t.agentId);
  }

  private mustExist(agentId: string): Account {
    const a = this.accounts.get(agentId);
    if (!a) throw new Error(`agent ${agentId} does not exist on the fake chain`);
    return a;
  }

  private record(agentId: string, from: string, events: RegistryEvent[]): string {
    const h = this.hash();
    this.txs.set(h, { agentId, from: from.toLowerCase(), events });
    return h;
  }

  // ---------- What the creator and the admin would do outside the server ----------

  /** The creator's wallet sent the batch and it was mined: returns the tx hash (not indexed yet). */
  land(kind: "register-agent" | "update-version" | "update-pricing", wallet: string, agentId: string, approved: ApprovedRecord): string {
    const id = agentIdToBytes32(agentId);
    const price = BigInt(approved.priceUsdc);
    const events: RegistryEvent[] = [];
    if (kind === "register-agent") {
      this.accounts.set(agentId, { creator: wallet.toLowerCase(), version: approved.version, versionHash: approved.versionHash, price, royaltyBps: approved.royaltyBps, status: "pending", index: this.nextIndex++ });
      events.push({
        name: "AgentRegistered",
        args: { agentId: id, creator: wallet, version: approved.version, versionHash: `0x${approved.versionHash}`, price, pricePerUse: 0n, royaltyBps: approved.royaltyBps },
      });
    } else {
      // The update batch also fixes the price and the royalty (before the first sale) when the approved ones differ.
      const a = this.mustExist(agentId);
      if (kind === "update-version") {
        a.version = approved.version;
        a.versionHash = approved.versionHash;
        events.push({ name: "AgentVersionUpdated", args: { agentId: id, version: approved.version, versionHash: `0x${approved.versionHash}` } });
      }
      if (a.price !== price || kind === "update-pricing") {
        a.price = price;
        events.push({ name: "PricingUpdated", args: { agentId: id, price, pricePerUse: 0n } });
      }
      if (a.royaltyBps !== approved.royaltyBps) {
        a.royaltyBps = approved.royaltyBps;
        events.push({ name: "RoyaltyBpsSet", args: { agentId: id, royaltyBps: approved.royaltyBps } });
      }
    }
    return this.record(agentId, wallet, events);
  }

  /** The creator called updateVersion/updatePricing DIRECTLY on-chain, with values the review never saw. */
  tamper(agentId: string, over: Partial<Pick<Account, "version" | "versionHash" | "price">>): string {
    const a = this.mustExist(agentId);
    Object.assign(a, over);
    return this.record(agentId, a.creator, [{ name: "AgentVersionUpdated", args: { agentId: agentIdToBytes32(agentId), version: a.version, versionHash: `0x${a.versionHash}` } }]);
  }

  /** The creator called updatePricing DIRECTLY on-chain (not reviewed). */
  tamperPrice(agentId: string, price: bigint): string {
    const a = this.mustExist(agentId);
    a.price = price;
    return this.record(agentId, a.creator, [{ name: "PricingUpdated", args: { agentId: agentIdToBytes32(agentId), price, pricePerUse: 0n } }]);
  }

  asState(agentId: string, a: Account): AgentChainState {
    return {
      agentId,
      view: {
        creator: a.creator,
        status: STATUS_CODE[a.status],
        royaltyBps: a.royaltyBps,
        totalSales: 0,
        maxSupply: 0,
        price: a.price,
        pricePerUse: 0n,
        disputesLost: 0,
        index: (a.index ??= this.nextIndex++),
        stake: 0n,
        versionHash: `0x${a.versionHash}`,
        version: a.version,
      },
      eval: { measured: false, scoreBps: 0, evalHash: ZERO_HASH },
      rating: { sum: 0n, count: 0 },
      verifiedUses: 0n,
    };
  }
}
