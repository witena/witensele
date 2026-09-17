CREATE TABLE IF NOT EXISTS "permission_grants" (
	"chat_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "permission_grants_chat_id_tool_name_pk" PRIMARY KEY("chat_id","tool_name"),
	CONSTRAINT "permission_grants_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE cascade
);
