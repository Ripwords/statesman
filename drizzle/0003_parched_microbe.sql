CREATE TABLE "project_access" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "project_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_id_project_id_fk" FOREIGN KEY ("id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_organization_id_project_access_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."project_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_organization_id_project_access_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."project_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_member_org_user_uq" ON "project_member" USING btree ("organization_id","user_id");
--> statement-breakpoint
INSERT INTO "project_access" ("id", "name", "slug", "created_at")
SELECT "id", "name", "id", now() FROM "project"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "project_member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::text, p."id", u."id", 'viewer', now()
FROM "project" p CROSS JOIN "user" u
WHERE coalesce(u."role", 'member') <> 'admin'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
