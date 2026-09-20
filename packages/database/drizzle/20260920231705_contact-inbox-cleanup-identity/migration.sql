CREATE UNIQUE INDEX "MessageCleanup_contactInboxId_key" ON "MessageCleanup" ("contactInboxId");
--> statement-breakpoint
DROP INDEX "MessageCleanup_inboxId_sourceId_key";
