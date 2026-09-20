-- Disposable synthetic test fixture, derived from the staged Drizzle snapshot.
-- Only contact/message/cleanup/shard tables; unrelated workspace/auth/quota FKs omitted.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TYPE "MessageCleanupStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "contentType" AS ENUM ('text', 'location', 'refLink');
CREATE TYPE "fileType" AS ENUM ('image', 'video', 'audio', 'gif', 'file');
CREATE TYPE "gender" AS ENUM ('male', 'female', 'unknown');
CREATE TYPE "lastUserInputType" AS ENUM ('text', 'location', 'refLink', 'image', 'video', 'audio', 'gif', 'file');
CREATE TYPE "messageKind" AS ENUM ('message', 'comment');
CREATE TYPE "messageType" AS ENUM ('incoming', 'outgoing', 'activity');
CREATE TYPE "senderType" AS ENUM ('bot', 'contact', 'system', 'user', 'api');
CREATE TABLE "Contact" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "avatar" text,
  "phoneNumber" text,
  "email" text,
  "emailVerified" boolean DEFAULT false NOT NULL,
  "emailOptIn" boolean DEFAULT true NOT NULL,
  "firstName" text,
  "lastName" text,
  "fullName" text GENERATED ALWAYS AS (CASE
        WHEN "firstName" IS NULL AND "lastName" IS NULL THEN NULL
        WHEN "firstName" IS NULL THEN "lastName"
        WHEN "lastName" IS NULL THEN "firstName"
        ELSE "firstName" || ' ' || "lastName"
      END) STORED,
  "gender" "gender",
  "lastReadAt" timestamp(6) with time zone,
  "ref" text,
  "country" text,
  "state" text,
  "city" text,
  "location" jsonb,
  "locale" text,
  "timezone" text,
  "subscribedAt" timestamp(6) with time zone,
  "broadcastSubscribedAt" timestamp(6) with time zone,
  "blockedAt" timestamp(6) with time zone,
  "workspaceId" bigint NOT NULL,
  PRIMARY KEY ("id")
);
CREATE TABLE "ContactInbox" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "originalContactId" bigint NOT NULL,
  "contactId" bigint NOT NULL,
  "inboxId" bigint NOT NULL,
  "channel" text NOT NULL,
  "source" text NOT NULL,
  "sourceId" text NOT NULL,
  "language" text,
  "personaId" text,
  "contactLastReadAt" timestamp(6) with time zone,
  "firstInteractionAt" timestamp(6) with time zone,
  "lastMessageAt" timestamp(6) with time zone,
  "lastIncomingMessageAt" timestamp(6) with time zone,
  "lastOutboundMessageAt" timestamp(6) with time zone,
  "referral" jsonb,
  "lastCommentMessageId" text,
  "lastCommentMessageAt" timestamp(6) with time zone,
  "consecutiveFailedReply" integer DEFAULT 0 NOT NULL,
  "lastInputFailure" text,
  "lastErrorLog" text,
  "lastBtnTitle" text,
  "lastUserInput" text,
  "lastUserInputType" "lastUserInputType",
  "webchatParentUrl" text,
  "sourceUserId" text,
  "sourceUsername" text,
  PRIMARY KEY ("id")
);
CREATE TABLE "Conversation" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "botEnabled" boolean DEFAULT true NOT NULL,
  "botResumeAt" timestamp(6) with time zone,
  "archivedAt" timestamp(6) with time zone,
  "additionalAttributes" jsonb,
  "contactLastReadAt" timestamp(6) with time zone,
  "agentLastReadAt" timestamp(6) with time zone,
  "aiContextLastMessageId" bigint,
  "lastActivityAt" timestamp(6) with time zone,
  "followed" boolean DEFAULT false NOT NULL,
  "assignedUserId" bigint,
  "assignedInboxTeamId" bigint,
  "workspaceId" bigint NOT NULL,
  "contactId" bigint NOT NULL,
  "sourceId" text,
  "lastStep" text,
  "currentStep" text,
  "adminRepliedAt" timestamp(6) with time zone,
  "contactRepliedAt" timestamp(6) with time zone,
  PRIMARY KEY ("id")
);
CREATE TABLE "Message" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "conversationId" bigint NOT NULL,
  "contactInboxId" bigint NOT NULL,
  "workspaceId" bigint NOT NULL,
  "text" text,
  "contentAttributes" jsonb,
  "messageType" "messageType" NOT NULL,
  "contentType" "contentType" NOT NULL,
  "senderType" "senderType" NOT NULL,
  "senderId" bigint,
  "sourceId" text,
  "deletedAt" timestamp with time zone,
  "type" "messageKind" DEFAULT 'message' NOT NULL,
  "parentId" text,
  "attributes" jsonb,
  "sendError" text,
  PRIMARY KEY ("id", "createdAt")
);
CREATE TABLE "Attachment" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "workspaceId" bigint NOT NULL,
  "conversationId" bigint NOT NULL,
  "messageId" bigint NOT NULL,
  "messageCreatedAt" timestamp(6) with time zone NOT NULL,
  "fileType" "fileType" NOT NULL,
  "sourceId" text,
  "mimeType" text NOT NULL,
  "width" integer,
  "height" integer,
  "size" integer DEFAULT 0 NOT NULL,
  "thumbnailPath" text,
  "originPath" text NOT NULL,
  "name" text,
  PRIMARY KEY ("id", "createdAt")
);
CREATE TABLE "MessageCleanup" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "workspaceId" bigint NOT NULL,
  "contactId" bigint NOT NULL,
  "contactInboxId" bigint NOT NULL,
  "inboxId" bigint NOT NULL,
  "sourceId" text NOT NULL,
  "conversationIds" jsonb NOT NULL,
  "sinceTime" timestamp(6) with time zone,
  "deletedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "status" "MessageCleanupStatus" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lastError" text,
  "processedAt" timestamp(6) with time zone,
  PRIMARY KEY ("id")
);
CREATE TABLE "MessageShard" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "name" text NOT NULL,
  "host" text NOT NULL,
  "port" integer DEFAULT 5432,
  "database" text NOT NULL,
  "user" text NOT NULL,
  "credentialRef" text,
  "sslMode" text DEFAULT 'disable',
  "isActive" boolean DEFAULT false,
  "isMain" boolean DEFAULT false,
  "shardKey" integer,
  "readHost" text,
  "readPort" integer,
  PRIMARY KEY ("id")
);
CREATE TABLE "ShardTimeRange" (
  "id" bigint NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "shardId" bigint NOT NULL,
  "startTime" timestamp(6) with time zone NOT NULL,
  "endTime" timestamp(6) with time zone,
  PRIMARY KEY ("id")
);
ALTER TABLE "ContactInbox" ADD CONSTRAINT "ContactInbox_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
SELECT create_hypertable('"Message"', 'createdAt', chunk_time_interval => INTERVAL '1 day');
ALTER TABLE "Message" SET (timescaledb.compress, timescaledb.compress_segmentby = '"conversationId"', timescaledb.compress_orderby = '"createdAt"');
SELECT create_hypertable('"Attachment"', 'createdAt', chunk_time_interval => INTERVAL '1 day');
ALTER TABLE "Attachment" SET (timescaledb.compress, timescaledb.compress_segmentby = '"conversationId"', timescaledb.compress_orderby = '"createdAt"');
CREATE UNIQUE INDEX "MessageCleanup_contactInboxId_key" ON "MessageCleanup" ("contactInboxId");
CREATE UNIQUE INDEX "ContactInbox_inboxId_sourceId_key" ON "ContactInbox" ("inboxId", "sourceId");
