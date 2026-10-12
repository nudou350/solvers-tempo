/**
 * Typed client of the Solvers API for the web app, scripts and agents. Every response is validated with the
 * `@solvers/shared` schemas, so a contract drift fails early.
 *
 * Transactions: the server never builds or signs a transaction. `build*` methods return the calls of ONE Tempo 0x76
 * batch (`TxResponse`); the wallet sends it with `feePayer: true` through the platform relay (`POST /api/relay`, a
 * JSON-RPC endpoint used by the wallet's viem transport, not by this client), then `confirm(txHash)` makes the server
 * wait for the receipt and index it right away. Login is SIWE (EIP-4361).
 *
 * Routes added or changed by the migration (phase 4 implements the server side against this list; every other route
 * below keeps its previous path and meaning):
 *
 * | Method | Path | Body / query | Response | Client method |
 * |---|---|---|---|---|
 * | GET | `/api/auth/nonce` | `?address=0x...` | `SiweNonce` | `login` (step 1) |
 * | POST | `/api/auth/verify` | `{ message, signature }` (SIWE message + EIP-191 signature) | `{ wallet }` | `login` (step 2) |
 * | GET | `/api/config` | | `PublicConfig` (chain id, contracts, payment token, fee, royalty, min price, pix, agentPay) | `getConfig` |
 * | GET | `/api/license/:tokenId` | | `LicenseMetadata` (ERC-721 `tokenURI` JSON) | `getLicenseMetadata` |
 * | POST | `/api/purchases/intent` | `PurchaseIntentInput` (`kind`: license, credits or escrow) | `PurchaseIntent` (`{ purchaseId, calls, chainId, feePayer, chargeId, kind, agentId, amountUnits }`) | `createPurchaseIntent`, `buildPurchase`, `buildEscrow` |
 * | GET | `/api/purchases/:chargeId` | | `ChargeView` | `getCharge` |
 * | POST | `/api/pix/charges` | `PurchaseIntentInput` | `PixCharge` (one purchase, fulfilled on-chain by the platform) | `createPixCharge` |
 * | POST | `/api/solana-pay/charges` | `PurchaseIntentInput` | `SolanaPayCharge` (one purchase paid in USDC on Solana, fulfilled on Tempo by the platform) | `createSolanaPayCharge` |
 * | GET | `/api/me/balance` | | `TokenBalance` (base units) | `getBalance` |
 * | GET | `/api/me/payouts` | | `DeferredPayouts` | `getMyPayouts` |
 * | GET | `/api/me/licenses/:id/transfer-quote` | | `RoyaltyQuote` | `getTransferQuote` |
 * | POST | `/api/me/memory-key` | `{ signature }` (EIP-191 hex of `MEMORY_KEY_MESSAGE`) | `{ ok }` | `unlockMemories` |
 * | POST | `/api/tx/transfer` | `{ licenseId, to, maxRoyaltyUnits }` | `TxResponse` (`[approve, transferWithRoyalty]`) | `buildTransfer` |
 * | POST | `/api/tx/claim` | | `TxResponse` (one `claim()` per contract holding a deferred payout) | `buildClaim` |
 * | POST | `/api/tx/review`, `/api/tx/escrow/:id/(release\|cancel-undelivered\|dispute)`, `/api/tx/(register-agent\|update-version\|update-pricing)` | unchanged | `TxResponse` (calls instead of a serialized transaction) | `build*` |
 * | POST | `/api/tx/escrow/:id/stale-dispute` | `{ index }` | `TxResponse` (refund of a dispute left without a ruling past its deadline) | `buildResolveStaleDispute` |
 * | POST | `/api/tx/creator/:idOrSlug/pricing` | `{ pricePerUseUnits }` | `TxResponse` (`updatePricing`, license price unchanged) | `buildCreatorPricing` |
 * | POST | `/api/tx/creator/:idOrSlug/royalty` | `{ royaltyBps }` | `TxResponse` (`setRoyaltyBps`, only before the first sale) | `buildCreatorRoyalty` |
 * | POST | `/api/tx/creator/:idOrSlug/supply-cap` | `{ max }` | `TxResponse` (`setSupplyCap`, raise only) | `buildCreatorSupplyCap` |
 * | POST | `/api/tx/creator/:idOrSlug/metadata` | `{ metadataUri? }` (default: the Solver's public metadata) | `TxResponse` (`updateMetadataUri`) | `buildCreatorMetadata` |
 * | POST | `/api/tx/creator/:idOrSlug/stake/top-up` | `{ amountUnits }` | `TxResponse` (`[approve, topUpStake]`) | `buildStakeTopUp` |
 * | POST | `/api/tx/creator/:idOrSlug/stake/exit` | | `TxResponse` (`requestStakeExit`: retires the Solver, 30-day wait) | `buildStakeExit` |
 * | POST | `/api/tx/creator/:idOrSlug/stake/cancel-exit` | | `TxResponse` (`cancelStakeExit`, not after an extension) | `buildStakeCancelExit` |
 * | POST | `/api/tx/creator/:idOrSlug/stake/withdraw` | | `TxResponse` (`withdrawStake`, from the exit date) | `buildStakeWithdraw` |
 * | POST | `/api/tx/creator/:idOrSlug/slash/contest` | `{ reason }` (10-4000 chars, off-chain; its hash goes on-chain) | `TxResponse` (`contestSlash`) | `buildSlashContest` |
 * | POST | `/api/tx/confirm` | `{ txHash }` | `ConfirmResponse` | `confirm`, `sendAndConfirm` |
 * | POST | `/api/tx/publication/confirm` | `{ submissionId, txHash, kind? }` | `PublicationResult` | `confirmPublication` |
 * | POST | `/api/faucet` | | `FaucetResponse` (`{ txHash, amountUnits }`) | `faucet` |
 * | POST | `/api/admin/escrow/:id/resolve` | unchanged | `{ txHash }` | `adminResolve` |
 * | POST | `/api/admin/agents/:id/approve` | relists a Solver already approved on-chain (`cli:approve` signs; the site signs nothing) | `{ agentId, listed }` | `adminApprove` |
 *
 * Removed: `POST /api/tx/submit` (the wallet broadcasts; use `/api/tx/confirm`), `POST /api/tx/purchase` and
 * `POST /api/tx/escrow` (both are `POST /api/purchases/intent` now, so every purchase has a ledger row and a purchase
 * id), and every route of the dropped secondary-market and cross-chain checkout features.
 */
import {
  AdminSubmissionDetail,
  AdminSubmissionRow,
  Agent,
  AgentAccess,
  type CatalogLang,
  AgentDetail,
  ChargeView,
  ConfirmResponse,
  ConnectorStatus,
  Creator,
  CreatorDashboard,
  CreatorMe,
  CreatorProfile,
  type CreatorProfileInput,
  type AdminReviewInput,
  type SubmissionStatus,
  SubmissionView,
  PublicationPlan,
  PublicationResult,
  type CreatorSigningStep,
  DeferredPayouts,
  Escrow,
  EscrowDetail,
  type EscrowTaskInput,
  FaucetResponse,
  GuaranteeStatus,
  License,
  LicenseMetadata,
  MEMORY_KEY_MESSAGE,
  Memory,
  MyTrial,
  PixCharge,
  SolanaPayCharge,
  Profile,
  PublicConfig,
  PurchaseIntent,
  type PurchaseIntentInput,
  ImageRef,
  Review,
  RoyaltyQuote,
  SiweNonce,
  TelegramLink,
  TokenBalance,
  TxHash,
  TxResponse,
  UsageSummary,
  UserReputation,
  Address,
  type Address as AddressT,
  type Call,
  type Hex,
} from "@solvers/shared";
import { createSiweMessage } from "viem/siwe";
import { z, type ZodTypeAny } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type ApiOptions = {
  /** API base. On the same domain as the web app, leave it empty ("") and use relative paths. */
  baseUrl?: string;
  /** Bearer token (SSR/tests/agents). In the browser the httpOnly session cookie is enough. */
  token?: string;
  fetch?: typeof fetch;
};

/** Minimal EVM wallet the client needs (Privy embedded wallet, dev wallet, agent keypair). */
export type WalletLike = {
  address: AddressT;
  /** EIP-191 `personal_sign` of a UTF-8 message; returns the 65-byte signature as hex. */
  signMessage(message: string): Promise<Hex>;
  /**
   * Sends the calls as one Tempo 0x76 batch with `feePayer: true` (the platform relay pays the fee) and returns the
   * transaction hash once it is broadcast.
   */
  sendCalls(calls: Call[], opts?: { chainId: number }): Promise<Hex>;
};

/** Where the SIWE message says the sign-in happens. Defaults to the page origin in a browser, else to `baseUrl`. */
export type SiweOrigin = { domain?: string; uri?: string };

/** `?lang=` for catalog texts (en = manifest, pt = locales/pt.json); without it the server uses Accept-Language. */
const withLang = (path: string, lang?: CatalogLang): string => (lang ? `${path}${path.includes("?") ? "&" : "?"}lang=${lang}` : path);

const enc = encodeURIComponent;

export function createApi(opts: ApiOptions = {}) {
  const base = (opts.baseUrl ?? "").replace(/\/$/, "");
  const f = opts.fetch ?? fetch;

  async function req<S extends ZodTypeAny>(schema: S, path: string, init: RequestInit = {}): Promise<z.infer<S>> {
    const res = await f(`${base}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, String(body.code ?? "error"), String(body.error ?? res.statusText), body);
    return schema.parse(body);
  }
  const post = <S extends ZodTypeAny>(schema: S, path: string, body?: unknown) =>
    req(schema, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  /** SIWE domain and URI: explicit values, else the page origin, else the API base URL. */
  function siweOrigin(origin: SiweOrigin): { domain: string; uri: string } {
    const loc = (globalThis as { location?: { host?: string; origin?: string } }).location;
    let fallback: URL | null = null;
    try {
      fallback = base ? new URL(base) : null;
    } catch {
      fallback = null;
    }
    const domain = origin.domain ?? loc?.host ?? fallback?.host;
    const uri = origin.uri ?? loc?.origin ?? fallback?.origin;
    if (!domain || !uri) throw new Error("SIWE needs a domain and uri: pass them to login() outside a browser without a baseUrl");
    return { domain, uri };
  }

  const txHashOnly = z.object({ txHash: TxHash }).passthrough();

  const api = {
    // ----- Store (public) -----
    getConfig: () => req(PublicConfig, "/api/config"),
    getAgents: (q: { q?: string; category?: string; sort?: "rating" | "uses" | "trend" | "new"; limit?: number; lang?: CatalogLang } = {}) => {
      const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
      return req(z.array(Agent), `/api/agents${p.size ? `?${p}` : ""}`);
    },
    getCategories: () => req(z.array(z.object({ category: z.string(), count: z.number() })), "/api/categories"),
    getAgent: (idOrSlug: string, lang?: CatalogLang) => req(AgentDetail, withLang(`/api/agents/${enc(idOrSlug)}`, lang)),
    getReviews: (idOrSlug: string) => req(z.array(Review), `/api/agents/${enc(idOrSlug)}/reviews`),
    search: (need: string, lang?: CatalogLang) => post(z.array(Agent), withLang("/api/search", lang), { need }),
    getCreator: (id: string, lang?: CatalogLang) => req(CreatorProfile, withLang(`/api/creators/${enc(id)}`, lang)),
    /** Creators with a Solver in the storefront: build a map by id for the cards (name and reputation). */
    getCreators: (lang?: CatalogLang) => req(z.array(Creator), withLang("/api/creators", lang)),
    /** ERC-721 metadata of a license (what `tokenURI` points to). */
    getLicenseMetadata: (tokenId: string | bigint) => req(LicenseMetadata, `/api/license/${enc(String(tokenId))}`),

    // ----- Sign-in with Ethereum (EIP-4361) -----
    /** Nonce, chain id, statement and expiry for a SIWE message. */
    getSiweNonce: (address: string) => req(SiweNonce, `/api/auth/nonce?${new URLSearchParams({ address })}`),
    /** Builds the SIWE message for the wallet, has it signed and opens the session (httpOnly cookie; `token` for agents). */
    async login(wallet: WalletLike, origin: SiweOrigin = {}) {
      const { domain, uri } = siweOrigin(origin);
      const n = await api.getSiweNonce(wallet.address);
      const message = createSiweMessage({
        address: wallet.address,
        chainId: n.chainId,
        domain,
        uri,
        nonce: n.nonce,
        statement: n.statement,
        version: "1",
        // The server's clock, not this device's: a wrong local clock would make the message "not yet valid" or expired.
        issuedAt: n.issuedAt ? new Date(n.issuedAt) : new Date(),
        expirationTime: new Date(n.expiresAt),
      });
      const signature = await wallet.signMessage(message);
      return post(z.object({ wallet: Address }).passthrough(), "/api/auth/verify", { message, signature });
    },
    logout: () => post(z.object({ ok: z.boolean() }), "/api/auth/logout"),
    me: () => req(z.object({ wallet: Address }).passthrough(), "/api/auth/me"),

    // ----- My account -----
    getMyLicenses: () => req(z.array(License), "/api/me/licenses"),
    refreshLicenses: () => post(z.object({ ok: z.boolean() }), "/api/me/licenses/refresh"),
    /** Royalty the owner pays to transfer this license (creator + platform shares of the original price). */
    getTransferQuote: (licenseId: string) => req(RoyaltyQuote, `/api/me/licenses/${enc(licenseId)}/transfer-quote`),
    getMyEscrows: () => req(z.array(Escrow), "/api/me/escrows"),
    getMyEscrow: (id: string, lang?: CatalogLang) => req(EscrowDetail, withLang(`/api/me/escrows/${enc(id)}`, lang)),
    downloadDeliverable: (escrowId: string, index: number) =>
      req(z.object({ files: z.record(z.string()) }), `/api/me/escrows/${enc(escrowId)}/milestones/${index}/download`),
    getMyUsage: () => req(z.array(UsageSummary), "/api/me/usage"),
    /** Guarantee limit of the wallet: how much it can still open and how many purchases are left for the full level. */
    getMyGuarantee: () => req(GuaranteeStatus, "/api/me/guarantee"),
    /** Free trials in progress (uses, searches and tool runs left). */
    getMyTrials: () => req(z.array(MyTrial), "/api/me/trials"),
    getMyAccess: (idOrSlug: string) => req(AgentAccess, `/api/me/access/${enc(idOrSlug)}`),
    getMemoriesCount: () =>
      req(z.object({ count: z.number(), agents: z.array(z.object({ agentId: z.string(), updatedAt: z.string() })) }), "/api/me/memories/count"),
    getReputation: () => req(UserReputation, "/api/me/reputation"),
    getProfile: (lang?: CatalogLang) => req(Profile, withLang("/api/me/profile", lang)),
    updateProfile: (data: { displayName?: string | null; email?: string | null }) =>
      req(z.object({ ok: z.boolean() }), "/api/me/profile", { method: "PATCH", body: JSON.stringify(data) }),
    /** Payment-token balance of the session wallet, in base units. */
    getBalance: () => req(TokenBalance, "/api/me/balance"),
    /** Payouts held for the wallet because a direct transfer to it was blocked; `buildClaim` withdraws them. */
    getMyPayouts: () => req(DeferredPayouts, "/api/me/payouts"),
    /** Testnet only (`PublicConfig.faucetEnabled`): funds the session wallet with the payment token. */
    faucet: () => post(FaucetResponse, "/api/faucet"),

    /** Memories: when the API answers 409 memory_key_required, call unlockMemories and retry. */
    getMemories: () => req(z.array(Memory), "/api/me/memories"),
    async unlockMemories(wallet: WalletLike, message: string = MEMORY_KEY_MESSAGE) {
      const signature = await wallet.signMessage(message);
      return post(z.object({ ok: z.boolean() }), "/api/me/memory-key", { signature });
    },
    deleteMemory: (id: string) => req(z.object({ ok: z.boolean() }), `/api/me/memories/${enc(id)}`, { method: "DELETE" }),
    deleteAllMemories: () => req(z.object({ ok: z.boolean() }), "/api/me/memories", { method: "DELETE" }),

    getConnector: () => req(ConnectorStatus, "/api/connector"),
    revokeConnector: () => post(z.object({ revoked: z.number() }), "/api/connector/revoke"),
    getCreatorDashboard: (lang?: CatalogLang) => req(CreatorDashboard, withLang("/api/creator/dashboard", lang)),

    // ----- Purchases -----
    /**
     * Starts a wallet purchase: the server writes the ledger row, derives the purchase id and returns the
     * `[approve, purchase]` batch. Extra errors: `sold_out` 409 (license cap reached, see `SUPPLY_ERROR_CODES`),
     * `price_changed` 409 (body carries the current price).
     */
    createPurchaseIntent: (input: PurchaseIntentInput) => post(PurchaseIntent, "/api/purchases/intent", input),
    /** Status of a purchase (any provider). */
    getCharge: (chargeId: string) => req(ChargeView, `/api/purchases/${enc(chargeId)}`),
    /** Lifetime license. `expectedPriceUnits` = the price the buyer saw (409 `price_changed` if it moved). */
    buildPurchase: (agentId: string, expectedPriceUnits?: bigint | string) =>
      api.createPurchaseIntent({ kind: "license", agentId, ...(expectedPriceUnits != null ? { expectedPriceUnits: String(expectedPriceUnits) } : {}) }),
    /**
     * Guaranteed task: milestones and criteria come from the creator's template (getAgent().guarantee); the buyer only
     * gives a title and describes what they want. acceptanceTests is optional, per milestone. deliveryDays is the
     * delivery deadline (optional; 0 or missing = 14, at most 60).
     */
    buildEscrow: (agentId: string, task: EscrowTaskInput) => api.createPurchaseIntent({ kind: "escrow", agentId, task }),
    /**
     * Pix: creates the charge for ONE purchase (QR / copy-and-paste). Once paid, the platform completes the purchase
     * on-chain for the session wallet; poll getPixCharge until `fulfilled`.
     */
    createPixCharge: (input: PurchaseIntentInput) => post(PixCharge, "/api/pix/charges", input),
    getPixCharge: (id: string) => req(PixCharge, `/api/pix/charges/${enc(id)}`),
    /** Only when getConfig().pix.simulate: marks the charge as paid without paying. */
    simulatePixPayment: (id: string) => post(PixCharge, `/api/pix/charges/${enc(id)}/simulate`),
    /**
     * Solana Pay: creates the charge for ONE purchase paid in USDC on Solana (transfer-request URL + QR). Once the
     * payment is found on Solana, the platform completes the purchase on Tempo for the session wallet; poll
     * getSolanaPayCharge until `fulfilled`. 400 `solana_pay_unavailable` when off, 429 `solana_pending_limit`.
     */
    createSolanaPayCharge: (input: PurchaseIntentInput) => post(SolanaPayCharge, "/api/solana-pay/charges", input),
    /** Own charge only; while unpaid the server re-checks Solana (and completes the purchase once paid). */
    getSolanaPayCharge: (id: string) => req(SolanaPayCharge, `/api/solana-pay/charges/${enc(id)}`),

    // ----- Transactions: the server returns the calls, the wallet sends them (fee sponsored) -----
    /** Attaches a photo to MY review of this Solver (up to 3; the review must exist). Returns the current photos. */
    uploadReviewImage: (idOrSlug: string, file: Blob) =>
      req(z.array(ImageRef), `/api/agents/${enc(idOrSlug)}/reviews/mine/images`, { method: "POST", headers: { "content-type": file.type }, body: file }),
    deleteReviewImage: (idOrSlug: string, imageId: string) =>
      req(z.array(ImageRef), `/api/agents/${enc(idOrSlug)}/reviews/mine/images/${enc(imageId)}`, { method: "DELETE" }),
    /** Asks this Solver's creator for help. Returns the ticket; the creator is notified and their contact stays hidden. */
    requestHelp: (idOrSlug: string, message: string, contact?: string) =>
      post(z.object({ protocol: z.string(), notified: z.boolean() }), `/api/agents/${enc(idOrSlug)}/help`, { message, contact: contact || undefined }),
    buildReview: (agentId: string, rating: number, text: string) => post(TxResponse, "/api/tx/review", { agentId, rating, text }),
    buildRelease: (escrowId: string, index: number) => post(TxResponse, `/api/tx/escrow/${enc(escrowId)}/release`, { index }),
    /** Undelivered milestone past its deadline: its amount goes back to the buyer, without a fee. */
    buildCancelUndelivered: (escrowId: string, index: number) => post(TxResponse, `/api/tx/escrow/${enc(escrowId)}/cancel-undelivered`, { index }),
    buildDispute: (escrowId: string, index: number, criterion: string, reason: string) =>
      post(TxResponse, `/api/tx/escrow/${enc(escrowId)}/dispute`, { index, criterion, reason }),
    /**
     * Transfers a license to another wallet. The owner pays the transfer royalty (creator + platform shares of the
     * original price, see getTransferQuote); `maxRoyaltyUnits` is the quote the owner accepted (the contract reverts
     * if the royalty went up).
     */
    buildTransfer: (licenseId: string, to: string, maxRoyaltyUnits: bigint | string) =>
      post(TxResponse, "/api/tx/transfer", { licenseId, to, maxRoyaltyUnits: String(maxRoyaltyUnits) }),
    /** Withdraws every deferred payout of the session wallet (see getMyPayouts). */
    buildClaim: () => post(TxResponse, "/api/tx/claim"),
    /** Dispute left without a ruling past its deadline: the buyer triggers the refund themselves. */
    buildResolveStaleDispute: (escrowId: string, index: number) => post(TxResponse, `/api/tx/escrow/${enc(escrowId)}/stale-dispute`, { index }),
    /** After the wallet broadcast the batch: the server waits for the receipt and indexes it right away. */
    confirm: (txHash: Hex) => post(ConfirmResponse.passthrough(), "/api/tx/confirm", { txHash }),
    /** Full flow: the wallet sends the built batch, then the server confirms and indexes it. */
    async sendAndConfirm(wallet: WalletLike, built: TxResponse) {
      const txHash = await wallet.sendCalls(built.calls, { chainId: built.chainId });
      return api.confirm(txHash);
    },

    // ----- Admin (needs the admin key on the server) -----
    adminDisputes: () =>
      req(z.array(z.object({ escrowId: z.string(), index: z.number(), title: z.string(), criteria: z.string(), criterion: z.string().nullable(), reason: z.string().nullable() })), "/api/admin/disputes"),
    adminResolve: (escrowId: string, index: number, refund: boolean) => post(txHashOnly, `/api/admin/escrow/${enc(escrowId)}/resolve`, { index, refund }),
    adminApprove: (agentId: string) => post(z.object({ agentId: z.string(), listed: z.boolean() }), `/api/admin/agents/${enc(agentId)}/approve`),

    // ----- Creator: sign-up, package submission and tracking (PACKAGE_SPEC.md 14.4) -----
    getCreatorMe: () => req(CreatorMe, "/api/creator/me"),
    saveCreatorProfile: (input: CreatorProfileInput) => post(CreatorMe, "/api/creator/profile", input),
    /** Code to link the creator's Telegram (single use, 15 min, 5 per hour). 503 `telegram_unavailable` when the bot is down. */
    createTelegramLink: () => post(TelegramLink, "/api/creator/telegram-link"),
    /** The server returns the ARRAY of submissions (newest first). `slug` and `version` are "" until the worker opens the ZIP. */
    listMySubmissions: () => req(z.array(SubmissionView), "/api/creator/submissions"),
    getMySubmission: (id: string) => req(SubmissionView, `/api/creator/submissions/${enc(id)}`),
    /**
     * Uploads the package ZIP (raw application/zip body; 202 `{ id, status }`). Uses XMLHttpRequest to report upload
     * progress (`onProgress` gets 0..1). `resubmit` = id of the submission with requested changes (same version).
     * Errors become `ApiError` (413 too large, 429 limits, 400/409 validation and conflict).
     */
    uploadSubmission: (file: Blob, up: { resubmit?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) =>
      new Promise<{ id: string; status: SubmissionStatus }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const qs = up.resubmit ? `?resubmit=${enc(up.resubmit)}` : "";
        xhr.open("POST", `${base}/api/creator/submissions${qs}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader("content-type", "application/zip");
        if (opts.token) xhr.setRequestHeader("authorization", `Bearer ${opts.token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) up.onProgress?.(Math.min(1, e.loaded / e.total));
        };
        xhr.onerror = () => reject(new ApiError(0, "network", "The connection dropped during the upload.", {}));
        xhr.ontimeout = () => reject(new ApiError(0, "timeout", "The upload took too long.", {}));
        xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled.", {}));
        xhr.onload = () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(xhr.responseText) as Record<string, unknown>;
          } catch {
            /* non-JSON response (e.g. an nginx 413) */
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new ApiError(xhr.status, String(body.code ?? "error"), String(body.error ?? xhr.statusText), body));
            return;
          }
          const parsed = z.object({ id: z.string(), status: z.string() }).safeParse(body);
          if (!parsed.success) reject(new ApiError(xhr.status, "bad_response", "Unexpected server response.", body));
          else resolve({ id: parsed.data.id, status: parsed.data.status as SubmissionStatus });
        };
        if (up.signal) {
          if (up.signal.aborted) xhr.abort();
          else up.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.send(file);
      }),

    /**
     * Creator's co-signature after the reviewer's approval (same flow as the checkout: build -> wallet sends ->
     * `confirmPublication`). The server reads price, hash and version from the approved record, never from here.
     */
    buildRegisterAgent: (submissionId: string) => post(TxResponse, "/api/tx/register-agent", { submissionId }),
    buildUpdateVersion: (submissionId: string) => post(TxResponse, "/api/tx/update-version", { submissionId }),
    buildUpdatePricing: (submissionId: string) => post(TxResponse, "/api/tx/update-pricing", { submissionId }),
    /**
     * What is missing for the Solver to go live (read from the chain on the spot): `step` says which button to show
     * (register-agent, update-version, update-pricing, await-admin-approval, ready, blocked) and `register` carries the
     * stake and balance at the registration step. Use `step` instead of trying the route and ignoring the 4xx.
     */
    getPublicationPlan: (submissionId: string) => req(PublicationPlan, `/api/tx/publication/${enc(submissionId)}`),
    /**
     * After the wallet sent the batch: links the tx hash to the submission and advances the flow. 409 errors:
     * submission_state, not_approved, wrong_step (`body.expected`), publication_blocked; 400 insufficient_funds.
     */
    confirmPublication: (submissionId: string, txHash: Hex, kind?: CreatorSigningStep) =>
      post(PublicationResult, "/api/tx/publication/confirm", { submissionId, txHash, ...(kind ? { kind } : {}) }),

    // ----- Creator: settings of a registered Solver (the creator's wallet signs; the server checks the contract rules first) -----
    /** Pay-per-use price of the credits in base units ("0" turns credits off); the license price stays the approved one. */
    buildCreatorPricing: (idOrSlug: string, pricePerUseUnits: bigint | string) =>
      post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/pricing`, { pricePerUseUnits: String(pricePerUseUnits) }),
    /** Creator share of the transfer royalty, in bps. 409 `royalty_locked` after the first sale; 400 `royalty_too_high`. */
    buildCreatorRoyalty: (idOrSlug: string, royaltyBps: number) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/royalty`, { royaltyBps }),
    /** License cap: the first cap needs at least max(1, sold); afterwards it can only go up (400 `supply_*`, 409 `supply_unchanged`). */
    buildCreatorSupplyCap: (idOrSlug: string, max: number) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/supply-cap`, { max }),
    /** Points the on-chain metadata link at `metadataUri` (default: the Solver's public metadata). 409 `metadata_unchanged`. */
    buildCreatorMetadata: (idOrSlug: string, metadataUri?: string) =>
      post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/metadata`, metadataUri ? { metadataUri } : {}),
    /** Adds to the Solver's stake (base units). 409 `agent_retired`; 400 `insufficient_funds`. */
    buildStakeTopUp: (idOrSlug: string, amountUnits: bigint | string) =>
      post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/stake/top-up`, { amountUnits: String(amountUnits) }),
    /** Starts the 30-day stake exit: the Solver is retired (no new sales; paid access keeps working). */
    buildStakeExit: (idOrSlug: string) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/stake/exit`),
    /** Gives up the stake exit (the Solver becomes suspended until the platform approves it again). 409 `stake_exit_extended`. */
    buildStakeCancelExit: (idOrSlug: string) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/stake/cancel-exit`),
    /** Withdraws the whole stake once the exit date passed. 409 `stake_exit_not_reached` (body carries `exitAt`). */
    buildStakeWithdraw: (idOrSlug: string) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/stake/withdraw`),
    /** Contests a proposed stake penalty once; the reason stays off-chain and its hash goes on-chain. */
    buildSlashContest: (idOrSlug: string, reason: string) => post(TxResponse, `/api/tx/creator/${enc(idOrSlug)}/slash/contest`, { reason }),

    // ----- Review queue (admin wallets only; CreatorMe.isAdmin says whether to show it) -----
    /** The server returns the ARRAY (oldest first when `pending_review`). */
    adminListSubmissions: (status?: SubmissionStatus) =>
      req(z.array(AdminSubmissionRow), `/api/admin/submissions${status ? `?${new URLSearchParams({ status })}` : ""}`),
    adminGetSubmission: (id: string) => req(AdminSubmissionDetail, `/api/admin/submissions/${enc(id)}`),
    /** Content of a package file as TEXT (never render it as HTML). */
    adminGetSubmissionFile: (id: string, path: string) =>
      req(z.object({ path: z.string(), content: z.string() }), `/api/admin/submissions/${enc(id)}/file?${new URLSearchParams({ path })}`),
    /** Test search over the package's staging ingestion. */
    adminSearchSubmissionKnowledge: (id: string, q: string) =>
      req(
        z.object({ query: z.string(), hits: z.array(z.object({ source: z.string(), content: z.string(), score: z.number() })) }),
        `/api/admin/submissions/${enc(id)}/knowledge-search?${new URLSearchParams({ q })}`,
      ),
    /** Approving freezes hash, price and version: answers `{ id, status, approved }`. */
    adminApproveSubmission: (id: string, input: AdminReviewInput) =>
      post(
        z.object({ id: z.string(), status: z.string(), approved: z.object({ versionHash: z.string(), priceUsdc: z.string(), royaltyBps: z.number(), name: z.string(), version: z.string() }) }),
        `/api/admin/submissions/${enc(id)}/approve`,
        input,
      ),
    adminRequestChanges: (id: string, input: AdminReviewInput) => post(z.object({ id: z.string(), status: z.string() }), `/api/admin/submissions/${enc(id)}/request-changes`, input),
    adminRejectSubmission: (id: string, input: AdminReviewInput) => post(z.object({ id: z.string(), status: z.string() }), `/api/admin/submissions/${enc(id)}/reject`, input),
    /** Revokes an approval the creator has not signed yet (back to `changes_requested`; note required). */
    adminRevokeSubmission: (id: string, input: AdminReviewInput) => post(z.object({ id: z.string(), status: z.string() }), `/api/admin/submissions/${enc(id)}/revoke`, input),
    /** Completes the publication when the on-chain approval event did not arrive on its own (idempotent). */
    adminFinishSubmission: (id: string) => post(PublicationResult, `/api/admin/submissions/${enc(id)}/finish`),
  };
  return api;
}

export type SolversApi = ReturnType<typeof createApi>;
export * from "@solvers/shared";
