-- Committees (Phase 9, S9.1): a named, ordered standing group of agents, and
-- the provenance column that records which committee a topic was convened from.
--
-- Hand-written like `0001_permission_grants.sql`, in the same shape the SQLite
-- migration `0005_ambiguous_sersi.sql` creates — `schema-drift.test.ts` is what
-- proves the two declarations stay equal.
--
-- `chats.committee_id` is `ON DELETE SET NULL`, not `CASCADE`: deleting a
-- committee erases the provenance of its topics and nothing else. The members
-- were snapshotted into `chat_members` when the chat was created, so the
-- conversation and its participants survive.

CREATE TABLE IF NOT EXISTS "committees" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "committee_members" (
	"committee_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "committee_members_committee_id_agent_id_pk" PRIMARY KEY("committee_id","agent_id"),
	CONSTRAINT "committee_members_committee_id_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "committees"("id") ON DELETE cascade,
	CONSTRAINT "committee_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "committee_id" text;
--> statement-breakpoint
ALTER TABLE "chats" DROP CONSTRAINT IF EXISTS "chats_committee_id_committees_id_fk";
--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_committee_id_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "committees"("id") ON DELETE set null;
