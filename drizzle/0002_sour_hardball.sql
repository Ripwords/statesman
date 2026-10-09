CREATE TABLE "environment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_link" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"ref" text NOT NULL,
	"directory" text DEFAULT '' NOT NULL,
	"last_synced_at" timestamp,
	"last_synced_sha" text,
	"last_sync_error" text,
	"declared" jsonb
);
--> statement-breakpoint
CREATE TABLE "variable" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"value_sealed" text NOT NULL,
	"sensitive" boolean DEFAULT true NOT NULL,
	"description" text,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_link" ADD CONSTRAINT "repository_link_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_link" ADD CONSTRAINT "repository_link_installation_id_github_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_project_slug_uq" ON "environment" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "repository_link_repo_ref_idx" ON "repository_link" USING btree ("repo_id","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "variable_environment_name_uq" ON "variable" USING btree ("environment_id","name");