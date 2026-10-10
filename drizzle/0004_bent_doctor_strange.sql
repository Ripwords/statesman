ALTER TABLE "project" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "retention_keep_versions" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "retention_keep_days" integer;