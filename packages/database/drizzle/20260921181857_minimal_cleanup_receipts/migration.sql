CREATE TABLE "MessageCleanupReceipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"completedAt" timestamp(6) with time zone NOT NULL,
	"expiresAt" timestamp(6) with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"implementationVersion" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "MessageCleanupReceipt_expiresAt_idx" ON "MessageCleanupReceipt" ("expiresAt");--> statement-breakpoint
CREATE INDEX "MessageCleanupReceipt_workspaceId_idx" ON "MessageCleanupReceipt" ("workspaceId");