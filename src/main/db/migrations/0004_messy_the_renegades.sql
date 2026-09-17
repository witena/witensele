CREATE TABLE `permission_grants` (
	`chat_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `tool_name`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
