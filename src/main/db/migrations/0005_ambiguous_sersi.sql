CREATE TABLE `committees` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `committee_members` (
	`committee_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`committee_id`, `agent_id`),
	FOREIGN KEY (`committee_id`) REFERENCES `committees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-edited after `npm run db:generate`: drizzle-kit emits the new column's
-- REFERENCES clause without the `ON DELETE set null` its own snapshot records
-- (meta/0005_snapshot.json has it), and the action is the point of the column —
-- deleting a committee must clear the provenance of its topics rather than be
-- refused by the foreign key. The two CREATE TABLEs above were also swapped so
-- `committees` exists before the table that references it.
ALTER TABLE `chats` ADD `committee_id` text REFERENCES `committees`(`id`) ON DELETE set null;
