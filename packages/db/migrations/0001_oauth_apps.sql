CREATE TABLE "oauth_apps" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"tenant" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
