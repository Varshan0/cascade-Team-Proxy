CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alert_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"symbol" text,
	"params" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" integer DEFAULT 1 NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"price_feed" text,
	"price_symbol" text
);
--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"instrument" text NOT NULL,
	"interval" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"open" numeric(38, 12) NOT NULL,
	"high" numeric(38, 12) NOT NULL,
	"low" numeric(38, 12) NOT NULL,
	"close" numeric(38, 12) NOT NULL,
	"volume" numeric(38, 12) DEFAULT '0' NOT NULL,
	"trades" integer,
	"source" text NOT NULL,
	CONSTRAINT "candles_instrument_interval_open_time_pk" PRIMARY KEY("instrument","interval","open_time")
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" numeric(38, 12) NOT NULL,
	"price" numeric(38, 12) NOT NULL,
	"fee" numeric(38, 12) NOT NULL,
	"liquidity" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"key" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"meta" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"symbol" text PRIMARY KEY NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"name" text NOT NULL,
	"coingecko_id" text,
	"coinbase_product_id" text,
	"pyth_feed_id" text,
	"chainlink_feed" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liquidations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"collateral_asset" text NOT NULL,
	"debt_asset" text NOT NULL,
	"user" text NOT NULL,
	"liquidator" text NOT NULL,
	"debt_amount_raw" numeric(80, 0) NOT NULL,
	"collateral_amount_raw" numeric(80, 0) NOT NULL,
	"usd_value" numeric(38, 12),
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onchain_proofs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signal_hash" text NOT NULL,
	"tx_hash" text,
	"chain_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onchain_proofs_signal_hash_unique" UNIQUE("signal_hash")
);
--> statement-breakpoint
CREATE TABLE "oracle_rounds" (
	"feed" text NOT NULL,
	"round_id" numeric(40, 0) NOT NULL,
	"answer" numeric(40, 0) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oracle_rounds_feed_round_id_pk" PRIMARY KEY("feed","round_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"tif" text DEFAULT 'GTC' NOT NULL,
	"qty" numeric(38, 12) NOT NULL,
	"limit_price" numeric(38, 12),
	"stop_price" numeric(38, 12),
	"status" text DEFAULT 'open' NOT NULL,
	"filled_qty" numeric(38, 12) DEFAULT '0' NOT NULL,
	"avg_price" numeric(38, 12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"qty" numeric(38, 12) NOT NULL,
	"avg_cost" numeric(38, 12) NOT NULL,
	"realized_pnl" numeric(38, 12) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_account_id_symbol_pk" PRIMARY KEY("account_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "provider_health_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instrument" text NOT NULL,
	"price" numeric(38, 12) NOT NULL,
	"size" numeric(38, 12),
	"side" text,
	"ts" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"suspect" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"watchlist_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "watchlist_items_watchlist_id_symbol_pk" PRIMARY KEY("watchlist_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alert_events_alert_idx" ON "alert_events" USING btree ("alert_id","ts");--> statement-breakpoint
CREATE INDEX "alerts_user_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alerts_active_idx" ON "alerts" USING btree ("active","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_chain_address_uq" ON "assets" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "fills_account_ts_idx" ON "fills" USING btree ("account_id","ts");--> statement-breakpoint
CREATE INDEX "ledger_account_asset_idx" ON "ledger_entries" USING btree ("account_id","asset");--> statement-breakpoint
CREATE INDEX "ledger_tx_idx" ON "ledger_entries" USING btree ("tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "liquidations_tx_log_uq" ON "liquidations" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "liquidations_ts_idx" ON "liquidations" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "liquidations_collateral_ts_idx" ON "liquidations" USING btree ("collateral_asset","ts");--> statement-breakpoint
CREATE INDEX "liquidations_block_idx" ON "liquidations" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "oracle_rounds_feed_ts_idx" ON "oracle_rounds" USING btree ("feed","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_account_idem_uq" ON "orders" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_account_created_idx" ON "orders" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("status","symbol");--> statement-breakpoint
CREATE INDEX "provider_health_provider_ts_idx" ON "provider_health_snapshots" USING btree ("provider","ts");--> statement-breakpoint
CREATE INDEX "signal_events_ts_idx" ON "signal_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ticks_instrument_ts_idx" ON "ticks" USING btree ("instrument","ts");--> statement-breakpoint
CREATE INDEX "watchlists_user_idx" ON "watchlists" USING btree ("user_id");