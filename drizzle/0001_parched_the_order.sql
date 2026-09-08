ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamp;--> statement-breakpoint
-- Every account that exists before this migration was made by an operator with
-- database access, and each one already had every power the dashboard offers.
-- Defaulting them to `member` would be a silent demotion that locks a running
-- deployment out of its own token management, with no admin left to undo it.
UPDATE "user" SET "role" = 'admin' WHERE "role" IS NULL;
