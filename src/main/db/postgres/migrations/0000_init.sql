-- The Postgres schema, in the shape `../schema.ts` describes today.
--
-- It starts at 0000 with the *current* shape rather than replaying the four
-- SQLite migrations, because a dialect that has never shipped has no history to
-- preserve: `0001` added `messages.in_reply_to`, `0002` `providers.auth` and
-- `0003` `chats.goal` to databases that already existed on somebody's laptop,
-- and there is no Postgres database anywhere that predates this file.
--
-- Statements are separated by drizzle's own `--> statement-breakpoint` marker so
-- the shared splitter in `../migrate.ts` reads this file and a generated one
-- identically.
--
-- Timestamps are `bigint`: they hold `Date.now()`, and Postgres `integer` is four
-- bytes. That single fact is why there is no dialect-neutral spelling of these
-- tables and why the migrations are per dialect.

CREATE TABLE IF NOT EXISTS "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"preset_id" text,
	"models" jsonb NOT NULL,
	"api_key_encrypted" text,
	"auth" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"avatar" jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"params" jsonb NOT NULL,
	"skill_names" jsonb NOT NULL,
	"mcp_server_ids" jsonb NOT NULL,
	"memory_enabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb,
	"env" jsonb,
	"url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"side_effects" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"workdir" text,
	"goal" jsonb,
	"settings" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_members" (
	"chat_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "chat_members_chat_id_agent_id_pk" PRIMARY KEY("chat_id","agent_id"),
	CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE cascade,
	CONSTRAINT "chat_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"seq" integer NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" text NOT NULL,
	"parts" jsonb NOT NULL,
	"status" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"mentions" jsonb NOT NULL,
	"in_reply_to" jsonb,
	"usage" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_created_idx" ON "messages" ("chat_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_seq_idx" ON "messages" ("chat_id","seq");
