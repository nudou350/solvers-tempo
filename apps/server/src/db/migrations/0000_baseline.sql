CREATE TABLE "agent_images" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"position" smallint NOT NULL,
	"key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_images_pos_chk" CHECK ("agent_images"."position" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "agent_published_versions" (
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"version_hash" text NOT NULL,
	"price_usdc" bigint NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approve_tx" varchar(66),
	CONSTRAINT "agent_published_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "agent_search_vectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(384) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"creator_id" text NOT NULL,
	"chain_index" integer,
	"version" text NOT NULL,
	"version_hash" text NOT NULL,
	"price" bigint NOT NULL,
	"price_per_use" bigint DEFAULT 0 NOT NULL,
	"royalty_bps" integer DEFAULT 0 NOT NULL,
	"eval_score_bps" integer DEFAULT 0 NOT NULL,
	"eval_hash" text,
	"eval_version_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"platform_status" text DEFAULT 'active' NOT NULL,
	"sync_flag" text DEFAULT 'ok' NOT NULL,
	"total_sales" bigint DEFAULT 0 NOT NULL,
	"max_licenses" integer,
	"verified_uses" bigint DEFAULT 0 NOT NULL,
	"rating_sum" bigint DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"disputes_lost" integer DEFAULT 0 NOT NULL,
	"stake" bigint DEFAULT 0 NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"package_contents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"guarantee_available" boolean DEFAULT false NOT NULL,
	"listed" boolean DEFAULT false NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_txs" (
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"wallet" varchar(42),
	"kind" text NOT NULL,
	"agent_id" text,
	"amount" bigint,
	"fee" bigint,
	"creator_amount" bigint,
	"creator_wallet" varchar(42),
	"fee_bps" integer,
	"block_number" bigint,
	"block_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_txs_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "creator_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"email" text,
	"note" text,
	"wallet" varchar(42),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"bio" text DEFAULT '' NOT NULL,
	"telegram_chat_id" text,
	"invited" boolean DEFAULT false NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"telegram_link_hash" text,
	"telegram_link_expires_at" timestamp with time zone,
	"telegram_link_window_start" timestamp with time zone,
	"telegram_link_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "creators_wallet_unique" UNIQUE("wallet")
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"agent_id" text NOT NULL,
	"owner_wallet" varchar(42) NOT NULL,
	"remaining" integer DEFAULT 0 NOT NULL,
	"purchased" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credits_agent_id_owner_wallet_pk" PRIMARY KEY("agent_id","owner_wallet")
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"buyer_wallet" varchar(42) NOT NULL,
	"creator_wallet" varchar(42) NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"purchase_id" varchar(66),
	"total" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"auto_release_at" timestamp with time zone,
	"review_window_secs" integer NOT NULL,
	"delivery_deadline" timestamp with time zone,
	"fee_bps" integer NOT NULL,
	"tx_hash" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_failures" (
	"tx_hash" varchar(66) PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"chunks_done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb,
	"valid_until" date,
	"embedding" vector(384)
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_wallet" varchar(42) NOT NULL,
	"original_price" bigint NOT NULL,
	"version_hash" text,
	"review_id" text,
	"burned" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text DEFAULT 'permanent' NOT NULL,
	"tx_hash" varchar(66)
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"agent_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_keys" (
	"token_id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"escrow_id" text NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"criteria" text NOT NULL,
	"criteria_hash" text NOT NULL,
	"verify" text DEFAULT 'tests' NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"passed_at" timestamp with time zone,
	"deliverable_path" text,
	"deliverable_hash" text,
	"preview_url" text,
	"acceptance_path" text,
	"acceptance_hash" text,
	"verifier_report" jsonb,
	"dispute_reason" text,
	"dispute_criterion" text,
	"disputed_at" timestamp with time zone,
	CONSTRAINT "milestones_escrow_id_idx_pk" PRIMARY KEY("escrow_id","idx")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text,
	"resource" text,
	"memory_key" "bytea",
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"refresh_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"reviewer_wallet" varchar(42) NOT NULL,
	"action" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version_hash" text,
	"diff_snapshot" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_wallet" varchar(42) NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"zip_path" text,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"manifest" jsonb,
	"validation" jsonb,
	"scans" jsonb,
	"approved" jsonb,
	"reviewer_notes" text,
	"register_tx" varchar(66),
	"approve_tx" varchar(66),
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_charge_id" text,
	"purchase_id" varchar(66) NOT NULL,
	"kind" text NOT NULL,
	"buyer_wallet" varchar(42) NOT NULL,
	"payer_wallet" varchar(42) NOT NULL,
	"agent_id" text NOT NULL,
	"intent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_brl_cents" bigint,
	"fx_rate" numeric(18, 8),
	"fx_source" text,
	"token_address" varchar(42) NOT NULL,
	"token_amount" bigint NOT NULL,
	"gross" bigint,
	"fee" bigint,
	"creator_amount" bigint,
	"creator_deferred" boolean,
	"tx_hash" varchar(66),
	"log_index" integer,
	"ref" varchar(66),
	"status" text DEFAULT 'created' NOT NULL,
	"error" text,
	"provider_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts_deferred" (
	"contract" varchar(42) NOT NULL,
	"recipient" varchar(42) NOT NULL,
	"amount" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_deferred_contract_recipient_pk" PRIMARY KEY("contract","recipient")
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"name" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "relay_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"sender" varchar(42),
	"ip" text,
	"method" text NOT NULL,
	"tx_hash" varchar(66),
	"gas_limit" bigint,
	"calls" jsonb,
	"status" text NOT NULL,
	"reason" text,
	"sign_payload" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_drafts" (
	"agent_id" text NOT NULL,
	"author_wallet" varchar(42) NOT NULL,
	"content_hash" text NOT NULL,
	"rating" smallint NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_drafts_agent_id_author_wallet_content_hash_pk" PRIMARY KEY("agent_id","author_wallet","content_hash")
);
--> statement-breakpoint
CREATE TABLE "review_images" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"position" smallint NOT NULL,
	"key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_images_pos_chk" CHECK ("review_images"."position" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"author_wallet" varchar(42) NOT NULL,
	"rating" smallint NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"version_hash" text,
	"token_id" text,
	"onchain" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_txs" (
	"account" varchar(42) NOT NULL,
	"lane" integer NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"valid_before" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sent_txs_tx_hash_pk" PRIMARY KEY("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"access" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"license_id" text,
	"calls" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"agent_id" text NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"searches_used" integer DEFAULT 0 NOT NULL,
	"tool_runs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trials_agent_id_wallet_pk" PRIMARY KEY("agent_id","wallet")
);
--> statement-breakpoint
CREATE TABLE "usage_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"count" integer NOT NULL,
	"merkle_root" text NOT NULL,
	"tx_hash" varchar(66),
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"agent_id" text,
	"session_id" text,
	"tool" text NOT NULL,
	"response_hash" text,
	"batched" boolean DEFAULT false NOT NULL,
	"batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"wallet" varchar(42) PRIMARY KEY NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_reputation" (
	"wallet" varchar(42) PRIMARY KEY NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"disputes_opened" integer DEFAULT 0 NOT NULL,
	"disputes_lost" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_persons" (
	"wallet" varchar(42) PRIMARY KEY NOT NULL,
	"person_key" varchar(64) NOT NULL,
	"privy_user_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_images_pos_idx" ON "agent_images" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "agent_search_vectors_agent_idx" ON "agent_search_vectors" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_chain_index_idx" ON "agents" USING btree ("chain_index") WHERE "agents"."chain_index" is not null;--> statement-breakpoint
CREATE INDEX "agents_fts_idx" ON "agents" USING gin (to_tsvector('portuguese', "search_text"));--> statement-breakpoint
CREATE INDEX "chain_txs_wallet_idx" ON "chain_txs" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "chain_txs_agent_idx" ON "chain_txs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "chain_txs_creator_idx" ON "chain_txs" USING btree ("creator_wallet","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_telegram_link_hash_idx" ON "creators" USING btree ("telegram_link_hash") WHERE "creators"."telegram_link_hash" is not null;--> statement-breakpoint
CREATE INDEX "escrows_buyer_idx" ON "escrows" USING btree ("buyer_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_jobs_submission_idx" ON "ingest_jobs" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "knowledge_agent_idx" ON "knowledge_chunks" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_fts_idx" ON "knowledge_chunks" USING gin (to_tsvector('portuguese', "content"));--> statement-breakpoint
CREATE INDEX "licenses_owner_idx" ON "licenses" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "licenses_agent_idx" ON "licenses" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_wallet_agent_idx" ON "memories" USING btree ("wallet","agent_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_wallet_idx" ON "oauth_tokens" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "package_reviews_submission_idx" ON "package_reviews" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "package_submissions_creator_idx" ON "package_submissions" USING btree ("creator_wallet","created_at");--> statement-breakpoint
CREATE INDEX "package_submissions_status_idx" ON "package_submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "package_submissions_slug_idx" ON "package_submissions" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ledger_payer_purchase_idx" ON "payment_ledger" USING btree ("payer_wallet","purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ledger_provider_charge_idx" ON "payment_ledger" USING btree ("provider","provider_charge_id") WHERE "payment_ledger"."provider_charge_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_ledger_status_idx" ON "payment_ledger" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "payment_ledger_buyer_idx" ON "payment_ledger" USING btree ("buyer_wallet");--> statement-breakpoint
CREATE INDEX "relay_log_sender_idx" ON "relay_log" USING btree ("sender","created_at");--> statement-breakpoint
CREATE INDEX "relay_log_ip_idx" ON "relay_log" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "relay_log_created_idx" ON "relay_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_images_pos_idx" ON "review_images" USING btree ("review_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_agent_author_idx" ON "reviews" USING btree ("agent_id","author_wallet");--> statement-breakpoint
CREATE INDEX "sent_txs_lane_nonce_idx" ON "sent_txs" USING btree ("account","lane","nonce");--> statement-breakpoint
CREATE INDEX "sent_txs_status_idx" ON "sent_txs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sent_txs_kind_ref_idx" ON "sent_txs" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "usage_batches_status_idx" ON "usage_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_agent_created_idx" ON "usage_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_wallet_idx" ON "usage_events" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "wallet_persons_person_idx" ON "wallet_persons" USING btree ("person_key");--> statement-breakpoint
-- Insert-only audit trail of package reviews (PACKAGE_SPEC.md 17, item 8): no UPDATE, DELETE or TRUNCATE.
CREATE FUNCTION "package_reviews_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'package_reviews is insert-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "package_reviews_no_update_delete" BEFORE UPDATE OR DELETE ON "package_reviews"
FOR EACH ROW EXECUTE FUNCTION "package_reviews_append_only"();--> statement-breakpoint
CREATE TRIGGER "package_reviews_no_truncate" BEFORE TRUNCATE ON "package_reviews"
FOR EACH STATEMENT EXECUTE FUNCTION "package_reviews_append_only"();
