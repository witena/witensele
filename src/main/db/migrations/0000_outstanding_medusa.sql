CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`params` text NOT NULL,
	`skill_names` text NOT NULL,
	`mcp_server_ids` text NOT NULL,
	`memory_enabled` integer DEFAULT false NOT NULL,
	`role` text DEFAULT 'participant' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_members` (
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `agent_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`workdir` text,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`side_effects` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`sender_type` text NOT NULL,
	`sender_id` text NOT NULL,
	`parts` text NOT NULL,
	`status` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`mentions` text NOT NULL,
	`usage` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_chat_created_idx` ON `messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_chat_seq_idx` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`preset_id` text,
	`models` text NOT NULL,
	`api_key_encrypted` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
