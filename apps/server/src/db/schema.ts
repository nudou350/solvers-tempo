import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import type { AgentTranslations, AgentVersion, BeforeAfter, Requirement } from "@solvers/shared";

// Mirror of the on-chain state (indexer, D9) plus off-chain data. Baseline schema of the Tempo migration (plan §3.7).
// Conventions: addresses are varchar(42) stored lowercase; tx hashes and bytes32 values are varchar(66) lowercase;
// token amounts are bigint base units (6 decimals for TIP-20), converted to numbers only at the API edge.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const u64 = (name: string) => bigint(name, { mode: "bigint" });
/** 20-byte address, lowercase. */
const addr = (name: string) => varchar(name, { length: 42 });
/** 32-byte value (tx hash, bytes32 id, content hash), lowercase 0x-prefixed. */
const b32 = (name: string) => varchar(name, { length: 66 });

export const creators = pgTable(
  "creators",
  {
    id: text("id").primaryKey(),
    wallet: addr("wallet").notNull().unique(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    bio: text("bio").notNull().default(""),
    telegramChatId: text("telegram_chat_id"),
    /** Invited to submit packages (PACKAGE_SPEC.md 14.1). */
    invited: boolean("invited").notNull().default(false),
    /** Creator terms accepted; required to submit a package. */
    termsAcceptedAt: ts("terms_accepted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Telegram linking (PACKAGE_SPEC.md 14.1): only the HASH of the one-time `LINK-XXXXXXXX` code, valid 15 min. */
    telegramLinkHash: text("telegram_link_hash"),
    telegramLinkExpiresAt: ts("telegram_link_expires_at"),
    /** 1 h window and how many codes were issued in it (max 5 per hour per creator). */
    telegramLinkWindowStart: ts("telegram_link_window_start"),
    telegramLinkCount: integer("telegram_link_count").notNull().default(0),
  },
  (t) => [uniqueIndex("creators_telegram_link_hash_idx").on(t.telegramLinkHash).where(sql`${t.telegramLinkHash} is not null`)],
);

/** Creator invites: the code goes by e-mail and the wallet is bound at first login. */
export const creatorInvites = pgTable("creator_invites", {
  code: text("code").primaryKey(),
  email: text("email"),
  note: text("note"),
  wallet: addr("wallet"),
  createdAt: ts("created_at").notNull().defaultNow(),
  usedAt: ts("used_at"),
});

/** Submission states (PACKAGE_SPEC.md 14.2); source of truth: SUBMISSION_STATUSES in @solvers/shared. */
export const packageSubmissions = pgTable(
  "package_submissions",
  {
    id: text("id").primaryKey(),
    creatorWallet: addr("creator_wallet").notNull(),
    /** Agent id (32 hex): assigned by the server on the first version of a slug; the on-chain id is bytes32(bytes16(id)) (D1). */
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("submitted"),
    zipPath: text("zip_path"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    validation: jsonb("validation").$type<Record<string, unknown>>(),
    scans: jsonb("scans").$type<Record<string, unknown>>(),
    /** Price/hash frozen at approval (the on-chain transaction reads from here, never from the client). */
    approved: jsonb("approved").$type<{ versionHash: string; priceUsdc: string; royaltyBps: number; name: string; version: string } | null>(),
    reviewerNotes: text("reviewer_notes"),
    /** Confirmed registration/update transaction and the on-chain approval (tx hashes). */
    registerTx: b32("register_tx"),
    approveTx: b32("approve_tx"),
    error: text("error"),
    /** Worker attempts (each claim counts); past the cap the submission is rejected (poison pill). */
    attempts: integer("attempts").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("package_submissions_creator_idx").on(t.creatorWallet, t.createdAt),
    index("package_submissions_status_idx").on(t.status),
    index("package_submissions_slug_idx").on(t.slug),
  ],
);

/** Review audit trail: INSERT ONLY (PACKAGE_SPEC.md 17, item 8). */
export const packageReviews = pgTable(
  "package_reviews",
  {
    id: serial("id").primaryKey(),
    submissionId: text("submission_id").notNull(),
    reviewerWallet: addr("reviewer_wallet").notNull(),
    action: text("action").notNull(), // approve | request_changes | reject | suspend | resume | finish
    notes: text("notes").notNull().default(""),
    checklist: jsonb("checklist").$type<Record<string, boolean>>().notNull().default({}),
    versionHash: text("version_hash"),
    diffSnapshot: jsonb("diff_snapshot").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("package_reviews_submission_idx").on(t.submissionId)],
);

/** Knowledge ingestion queue in the worker, with a checkpoint per file (PACKAGE_SPEC.md 16). */
export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: serial("id").primaryKey(),
    submissionId: text("submission_id").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    filesTotal: integer("files_total").notNull().default(0),
    filesDone: integer("files_done").notNull().default(0),
    chunksDone: integer("chunks_done").notNull().default(0),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("ingest_jobs_submission_idx").on(t.submissionId)],
);

/** Version approved by review; the indexer compares the chain with this table (PACKAGE_SPEC.md 15.4). Written BEFORE any transaction. */
export const agentPublishedVersions = pgTable(
  "agent_published_versions",
  {
    agentId: text("agent_id").notNull(),
    version: text("version").notNull(),
    versionHash: text("version_hash").notNull(),
    priceUsdc: u64("price_usdc").notNull(),
    approvedAt: ts("approved_at").notNull().defaultNow(),
    approveTx: b32("approve_tx"),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.version] })],
);

export type AgentDetails = {
  beforeAfter?: BeforeAfter[];
  versions?: AgentVersion[];
  tools?: { name: string; description: string; runner: string }[];
  guaranteeCriteria?: string[];
  /** Guarantee task template defined by the creator (manifest.guarantee). */
  guaranteeTemplate?: { priceUsdc: number; milestones: { title: string; criteria: string[]; sharePct: number; verify: "tests" | "manual" }[] };
  catalogOnly?: boolean;
};

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(), // manifest id, 32 hex (on-chain: bytes32(bytes16(id)), D1)
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    creatorId: text("creator_id").notNull(),
    /** Position in the Registry's agentIds array (the license slot stores this index); null until registered on-chain. */
    chainIndex: integer("chain_index"),
    version: text("version").notNull(),
    /** Every version_hash column stores 64 lowercase hex WITHOUT 0x (the package hash form); bytes32 on-chain adds 0x. */
    versionHash: text("version_hash").notNull(),
    price: u64("price").notNull(),
    pricePerUse: u64("price_per_use").notNull().default(sql`0`),
    /** Creator share of the transfer royalty (bps of the original price, D15). */
    royaltyBps: integer("royalty_bps").notNull().default(0),
    /** Eval of `evalVersionHash` (D6): "measured" only when it equals versionHash. */
    evalScoreBps: integer("eval_score_bps").notNull().default(0),
    evalHash: text("eval_hash"),
    evalVersionHash: text("eval_version_hash"),
    status: text("status").notNull().default("pending"), // pending | active | suspended | retired (on-chain mirror; the indexer rewrites it)
    /** Platform kill switch: active | suspended. NEVER written by the indexer (PACKAGE_SPEC.md 15.4). */
    platformStatus: text("platform_status").notNull().default("active"),
    /** ok | unapproved_chain_version: the chain diverged from the approved version (sales blocked). Written only by the indexer. */
    syncFlag: text("sync_flag").notNull().default("ok"),
    totalSales: u64("total_sales").notNull().default(sql`0`),
    /** License cap (on-chain `maxSupply`). null = unlimited. */
    maxLicenses: integer("max_licenses"),
    verifiedUses: u64("verified_uses").notNull().default(sql`0`),
    ratingSum: u64("rating_sum").notNull().default(sql`0`),
    ratingCount: integer("rating_count").notNull().default(0),
    disputesLost: integer("disputes_lost").notNull().default(0),
    stake: u64("stake").notNull().default(sql`0`),
    requirements: jsonb("requirements").$type<Requirement[]>().notNull().default([]),
    packageContents: jsonb("package_contents").$type<string[]>().notNull().default([]),
    /** Catalog texts per language (locales/<lang>.json of the package): { pt: {...} }. English is in the columns above. */
    translations: jsonb("translations").$type<AgentTranslations>().notNull().default({}),
    guaranteeAvailable: boolean("guarantee_available").notNull().default(false),
    /** Only shown in the store after the catalog (publish-agent) filled the data. */
    listed: boolean("listed").notNull().default(false),
    details: jsonb("details").$type<AgentDetails>().notNull().default({}),
    searchText: text("search_text").notNull().default(""),
    embedding: vector("embedding", { dimensions: 384 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_chain_index_idx").on(t.chainIndex).where(sql`${t.chainIndex} is not null`),
    index("agents_fts_idx").using("gin", sql`to_tsvector('portuguese', ${t.searchText})`),
  ],
);

export const licenses = pgTable(
  "licenses",
  {
    id: text("id").primaryKey(), // ERC-721 tokenId (decimal string)
    agentId: text("agent_id").notNull(),
    ownerWallet: addr("owner_wallet").notNull(),
    /** Price paid at the primary sale: base of the transfer royalty. */
    originalPrice: u64("original_price").notNull(),
    /** Package version current when the license was minted. */
    versionHash: text("version_hash"),
    /** Review the license backs on-chain (reviewId), null when unused. */
    reviewId: text("review_id"),
    burned: boolean("burned").notNull().default(false),
    acquiredAt: ts("acquired_at").notNull().defaultNow(),
    type: text("type").notNull().default("permanent"),
    /** Mint transaction. */
    txHash: b32("tx_hash"),
  },
  (t) => [index("licenses_owner_idx").on(t.ownerWallet), index("licenses_agent_idx").on(t.agentId)],
);

export const credits = pgTable(
  "credits",
  {
    agentId: text("agent_id").notNull(),
    ownerWallet: addr("owner_wallet").notNull(),
    remaining: integer("remaining").notNull().default(0),
    purchased: integer("purchased").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.ownerWallet] })],
);

/** Free trial (off-chain) per wallet and Solver: uses, searches and tool runs (manifest.trial). */
export const trials = pgTable(
  "trials",
  {
    agentId: text("agent_id").notNull(),
    wallet: addr("wallet").notNull(),
    used: integer("used").notNull().default(0),
    searchesUsed: integer("searches_used").notNull().default(0),
    toolRuns: jsonb("tool_runs").$type<Record<string, number>>().notNull().default({}),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.wallet] })],
);

export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(), // `${agentId}:${authorWallet}` (one review per agent and author on-chain)
    agentId: text("agent_id").notNull(),
    authorWallet: addr("author_wallet").notNull(),
    rating: smallint("rating").notNull(),
    text: text("text").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    /** Agent versionHash current at submission (D6). */
    versionHash: text("version_hash"),
    /** License used (null = reviewed with credits). */
    tokenId: text("token_id"),
    onchain: boolean("onchain").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reviews_agent_author_idx").on(t.agentId, t.authorWallet)],
);

/** Review drafts: text and rating prepared before the transaction, by content hash; they become `reviews.text` only when the indexer sees the same hash on-chain. */
export const reviewDrafts = pgTable(
  "review_drafts",
  {
    agentId: text("agent_id").notNull(),
    authorWallet: addr("author_wallet").notNull(),
    contentHash: text("content_hash").notNull(),
    rating: smallint("rating").notNull(),
    text: text("text").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.authorWallet, t.contentHash] })],
);

/** Creator gallery (up to 5) and review photos (up to 3); positions are unique per owner so concurrent uploads never exceed the cap. */
export const agentImages = pgTable(
  "agent_images",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    position: smallint("position").notNull(),
    key: text("key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_images_pos_idx").on(t.agentId, t.position), check("agent_images_pos_chk", sql`${t.position} between 0 and 4`)],
);

export const reviewImages = pgTable(
  "review_images",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id").notNull(),
    position: smallint("position").notNull(),
    key: text("key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("review_images_pos_idx").on(t.reviewId, t.position), check("review_images_pos_chk", sql`${t.position} between 0 and 2`)],
);

export const escrows = pgTable(
  "escrows",
  {
    id: text("id").primaryKey(), // on-chain escrowId (decimal string)
    agentId: text("agent_id").notNull(),
    buyerWallet: addr("buyer_wallet").notNull(),
    creatorWallet: addr("creator_wallet").notNull(),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    /** Purchase id of the creation (D10/§4.8). */
    purchaseId: b32("purchase_id"),
    total: u64("total").notNull(),
    /** Derived on-chain status: active | approved (contract Completed) | disputed | refunded (D19: no stored `closed`). */
    status: text("status").notNull().default("active"),
    autoReleaseAt: ts("auto_release_at"),
    reviewWindowSecs: integer("review_window_secs").notNull(),
    deliveryDeadline: ts("delivery_deadline"),
    /** Platform fee frozen at creation (bps). */
    feeBps: integer("fee_bps").notNull(),
    txHash: b32("tx_hash"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("escrows_buyer_idx").on(t.buyerWallet)],
);

export const milestones = pgTable(
  "milestones",
  {
    escrowId: text("escrow_id").notNull(),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    criteria: text("criteria").notNull(),
    criteriaHash: text("criteria_hash").notNull(),
    /** tests: automatic verifier; manual: the buyer reviews the deliverable. */
    verify: text("verify").notNull().default("tests"),
    amount: u64("amount").notNull(),
    status: text("status").notNull().default("pending"),
    passedAt: ts("passed_at"),
    deliverablePath: text("deliverable_path"),
    deliverableHash: text("deliverable_hash"),
    previewUrl: text("preview_url"),
    /** Acceptance battery agreed at creation (the deliverable cannot replace it). */
    acceptancePath: text("acceptance_path"),
    acceptanceHash: text("acceptance_hash"),
    verifierReport: jsonb("verifier_report").$type<Record<string, unknown>>(),
    disputeReason: text("dispute_reason"),
    disputeCriterion: text("dispute_criterion"),
    disputedAt: ts("disputed_at"),
  },
  (t) => [primaryKey({ columns: [t.escrowId, t.idx] })],
);

/** Off-chain profile data (name and e-mail come from the e-mail login). */
export const userProfiles = pgTable("user_profiles", {
  wallet: addr("wallet").primaryKey(),
  displayName: text("display_name"),
  email: text("email"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const userReputation = pgTable("user_reputation", {
  wallet: addr("wallet").primaryKey(),
  purchases: integer("purchases").notNull().default(0),
  disputesOpened: integer("disputes_opened").notNull().default(0),
  disputesLost: integer("disputes_lost").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    wallet: addr("wallet").notNull(),
    agentId: text("agent_id"),
    sessionId: text("session_id"),
    tool: text("tool").notNull(),
    responseHash: text("response_hash"),
    batched: boolean("batched").notNull().default(false),
    /** Batch being sent (marked before the transaction so a use is never counted twice). */
    batchId: text("batch_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("usage_agent_created_idx").on(t.agentId, t.createdAt), index("usage_wallet_idx").on(t.wallet)],
);

/** Usage batches sent on-chain (recordUsageBatch). The tx hash is recorded BEFORE broadcast (sent_txs) for reconciliation. */
export const usageBatches = pgTable(
  "usage_batches",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    count: integer("count").notNull(),
    merkleRoot: text("merkle_root").notNull(),
    txHash: b32("tx_hash"),
    status: text("status").notNull().default("pending"), // pending | confirmed | released
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("usage_batches_status_idx").on(t.status)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  wallet: addr("wallet").notNull(),
  agentId: text("agent_id").notNull(),
  version: text("version").notNull(),
  stepIndex: integer("step_index").notNull().default(0),
  access: text("access").notNull(), // license | guarantee (context.escrowId) | trial | credits
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  licenseId: text("license_id"),
  calls: integer("calls").notNull().default(0),
  expiresAt: ts("expires_at").notNull().default(sql`now() + interval '24 hours'`),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** SIWE nonces (D7): single use, short TTL. */
export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  wallet: addr("wallet").notNull(),
  purpose: text("purpose").notNull().default("login"),
  expiresAt: ts("expires_at").notNull(),
});

export const oauthClients = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const oauthCodes = pgTable("oauth_codes", {
  code: text("code").primaryKey(),
  clientId: text("client_id").notNull(),
  wallet: addr("wallet").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  memoryKey: bytea("memory_key"), // memory key already wrapped with the KEK
  expiresAt: ts("expires_at").notNull(),
});

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    wallet: addr("wallet").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("oauth_tokens_wallet_idx").on(t.wallet)],
);

/** Memory key per token session (wrapped with SERVER_KEK). Gone when it expires. */
export const memoryKeys = pgTable("memory_keys", {
  tokenId: text("token_id").primaryKey(),
  wallet: addr("wallet").notNull(),
  wrappedKey: bytea("wrapped_key").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    wallet: addr("wallet").notNull(),
    agentId: text("agent_id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    tag: bytea("tag").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memories_wallet_agent_idx").on(t.wallet, t.agentId)],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    content: text("content").notNull(),
    /** File front-matter (title, source, source_url, source_date, tags, trial); PACKAGE_SPEC.md 6.2. */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    /** End of validity of the excerpt (valid_until); afterwards search warns "may be outdated". */
    validUntil: date("valid_until"),
    embedding: vector("embedding", { dimensions: 384 }),
  },
  (t) => [
    index("knowledge_agent_idx").on(t.agentId, t.version),
    index("knowledge_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("knowledge_fts_idx").using("gin", sql`to_tsvector('portuguese', ${t.content})`),
  ],
);

/** Extra store-search vectors (tagline and searchPhrases, also in Portuguese); rewritten on every publish. */
export const agentSearchVectors = pgTable(
  "agent_search_vectors",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
  },
  (t) => [index("agent_search_vectors_agent_idx").on(t.agentId)],
);

/** Indexer idempotency (D9): one row per processed log. */
export const processedEvents = pgTable(
  "processed_events",
  {
    txHash: b32("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: u64("block_number").notNull(),
    name: text("name").notNull(),
    processedAt: ts("processed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })],
);

/** Transactions whose events failed to apply: retried without blocking the cursor. */
export const indexerFailures = pgTable("indexer_failures", {
  txHash: b32("tx_hash").primaryKey(),
  /** Only non-infrastructure failures count (an RPC outage spends no attempts). */
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error").notNull(),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  /** pending (retried) | dead (gave up: manual reprocess, see cli:reindex). */
  status: text("status").notNull().default("pending"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Key-value store (indexer cursor `indexer:evm:<chainId>` = { block, blockHash }). */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Every money-moving event seen by the indexer (history, "verify on the explorer", creator dashboard). */
export const chainTxs = pgTable(
  "chain_txs",
  {
    txHash: b32("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    wallet: addr("wallet"),
    /** purchase | credits | escrow | royalty | release | refund | slash | claim | stake */
    kind: text("kind").notNull(),
    agentId: text("agent_id"),
    /** Gross amount moved (price, credits total, escrow deposit, released milestone, royalty). */
    amount: u64("amount"),
    fee: u64("fee"),
    creatorAmount: u64("creator_amount"),
    creatorWallet: addr("creator_wallet"),
    feeBps: integer("fee_bps"),
    blockNumber: u64("block_number"),
    blockTime: ts("block_time"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("chain_txs_wallet_idx").on(t.wallet),
    index("chain_txs_agent_idx").on(t.agentId),
    index("chain_txs_creator_idx").on(t.creatorWallet, t.kind),
  ],
);

export const escalations = pgTable("escalations", {
  id: text("id").primaryKey(),
  wallet: addr("wallet").notNull(),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id"),
  summary: text("summary").notNull(),
  status: text("status").notNull().default("open"),
  notified: boolean("notified").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Payment ledger (plan §5): one row per charge of any provider (direct-wallet, pix-intermediated, agent-pay). Written
 * BEFORE any provider call or transaction; `purchase_id` = keccak256("solvers:v1:" + chargeId) is unique and is what the
 * contracts record (scoped by payer, X22).
 */
export const paymentLedger = pgTable(
  "payment_ledger",
  {
    id: text("id").primaryKey(), // chargeId
    provider: text("provider").notNull(), // direct-wallet | pix-intermediated | agent-pay | fake
    providerChargeId: text("provider_charge_id"),
    purchaseId: b32("purchase_id").notNull(),
    kind: text("kind").notNull(), // license | credits | escrow
    buyerWallet: addr("buyer_wallet").notNull(),
    /** Wallet that pays on-chain (the buyer for direct-wallet, PLATFORM for Pix and agent-pay). */
    payerWallet: addr("payer_wallet").notNull(),
    agentId: text("agent_id").notNull(),
    /** Purchase details (credits amount, escrow milestones) needed to fulfil exactly what was charged. */
    intent: jsonb("intent").$type<Record<string, unknown>>().notNull().default({}),
    amountBrlCents: bigint("amount_brl_cents", { mode: "bigint" }),
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }),
    fxSource: text("fx_source"),
    tokenAddress: addr("token_address").notNull(),
    tokenAmount: u64("token_amount").notNull(),
    gross: u64("gross"),
    fee: u64("fee"),
    creatorAmount: u64("creator_amount"),
    creatorDeferred: boolean("creator_deferred"),
    txHash: b32("tx_hash"),
    logIndex: integer("log_index"),
    /** On-chain ref (tokenId / escrowId / buyer) from purchaseRef. */
    ref: b32("ref"),
    status: text("status").notNull().default("created"),
    error: text("error"),
    providerPayload: jsonb("provider_payload").$type<Record<string, unknown>>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    confirmedAt: ts("confirmed_at"),
    fulfilledAt: ts("fulfilled_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // review fix: purchase ids are scoped by payer on-chain (X22), so the ledger key is (payer, purchaseId).
    uniqueIndex("payment_ledger_payer_purchase_idx").on(t.payerWallet, t.purchaseId),
    uniqueIndex("payment_ledger_provider_charge_idx")
      .on(t.provider, t.providerChargeId)
      .where(sql`${t.providerChargeId} is not null`),
    index("payment_ledger_status_idx").on(t.status, t.updatedAt),
    index("payment_ledger_buyer_idx").on(t.buyerWallet),
  ],
);

/** Mirror of the contracts' `deferred[recipient]` (D5): what each recipient can `claim()` from each contract. */
export const payoutsDeferred = pgTable(
  "payouts_deferred",
  {
    contract: addr("contract").notNull(),
    recipient: addr("recipient").notNull(),
    amount: u64("amount").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contract, t.recipient] })],
);

/** Every request the fee-paying relay handled (D3): sponsored, refused or failed. */
export const relayLog = pgTable(
  "relay_log",
  {
    id: serial("id").primaryKey(),
    sender: addr("sender"),
    ip: text("ip"),
    method: text("method").notNull(),
    txHash: b32("tx_hash"),
    gasLimit: u64("gas_limit"),
    calls: jsonb("calls").$type<{ to: string; selector: string }[]>(),
    /** sponsored | refused | failed | reserved (quota held while a fill is being co-signed) */
    status: text("status").notNull(),
    reason: text("reason"),
    /** area: auth. Fee-payer sign payload (stable id of the co-signed envelope; fills have no tx hash yet). */
    signPayload: b32("sign_payload"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("relay_log_sender_idx").on(t.sender, t.createdAt),
    index("relay_log_ip_idx").on(t.ip, t.createdAt),
    // review fix: the global daily budget sums every active row of the last 24 h
    index("relay_log_created_idx").on(t.createdAt),
  ],
);

/**
 * Journal of server-sent transactions per 2D nonce lane (D3): the hash is written BEFORE broadcast; `validBefore` lets a
 * stuck transaction expire; the next nonce of a lane is recovered from the chain at boot.
 */
export const sentTxs = pgTable(
  "sent_txs",
  {
    account: addr("account").notNull(),
    lane: integer("lane").notNull(),
    nonce: u64("nonce").notNull(),
    txHash: b32("tx_hash").notNull(),
    /** What the transaction does (pix-fulfil, agent-pay-fulfil, mark-passed, usage-batch, admin-...). */
    kind: text("kind").notNull(),
    /** Business reference (chargeId, escrowId:index, batchId). */
    ref: text("ref"),
    /** pending | confirmed | reverted | expired */
    status: text("status").notNull().default("pending"),
    validBefore: ts("valid_before"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Keyed by hash: an expired, never-included transaction leaves its nonce unused and the next send reuses it,
    // so (account, lane, nonce) is not unique across the journal.
    primaryKey({ columns: [t.txHash] }),
    index("sent_txs_lane_nonce_idx").on(t.account, t.lane, t.nonce),
    index("sent_txs_status_idx").on(t.status),
    // review fix: journal lookups by business reference (sentTxsFor(kind, ref)).
    index("sent_txs_kind_ref_idx").on(t.kind, t.ref),
  ],
);

// ---- area: auth ----

/**
 * Wallet linked to a person through a verified Privy identity token (auth/privy.ts): the free trial can count every wallet
 * of the same e-mail as one person (auth/person.ts). Only the hash of the normalized e-mail is stored.
 */
export const walletPersons = pgTable(
  "wallet_persons",
  {
    wallet: addr("wallet").primaryKey(),
    personKey: varchar("person_key", { length: 64 }).notNull(),
    /** Privy user DID (`sub`). */
    privyUserId: text("privy_user_id").notNull(),
    linkedAt: ts("linked_at").notNull().defaultNow(),
  },
  (t) => [index("wallet_persons_person_idx").on(t.personKey)],
);
