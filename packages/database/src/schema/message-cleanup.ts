import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { messageCleanupStatuses } from "../partials/message-cleanup"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"

export const messageCleanupStatus = pgEnum(
  "MessageCleanupStatus",
  messageCleanupStatuses.options as [string, ...string[]],
)

/**
 * Tombstone queue for messages orphaned by a contact delete.
 *
 * Message/Attachment are TimescaleDB hypertables with compressed chunks, so
 * they no longer cascade from Contact/Conversation (deleting compressed rows
 * inline hits the decompression limit). Instead, deleting a contact upserts one
 * row per deleted contact-inbox here; the actual message purge is performed
 * later by a separate process reading `pending` rows.
 *
 * Rows snapshot everything needed for the purge because the source rows are
 * gone by the time it runs. No column carries an FK — `workspaceId`,
 * `contactId`, `contactInboxId`, and `conversationIds` all reference rows that
 * are deleted (or being deleted) by the time this row is written, and the
 * table must outlive them. Each deleted contact-inbox has its own tombstone:
 * a returning sender gets a new contact-inbox id, so repeated deletes cannot
 * overwrite the shard identity needed to erase the earlier history.
 * Successful purges replace this identifying row with a separate, short-lived
 * receipt. Unfinished rows remain available for retries and operator recovery.
 */
export const messageCleanupModel = pgTable(
  "MessageCleanup",
  {
    ...sharedColumns,
    workspaceId: bigintAsString().notNull(),
    contactId: bigintAsString().notNull(),
    contactInboxId: bigintAsString().notNull(),
    inboxId: bigintAsString().notNull(),
    sourceId: text().notNull(),
    conversationIds: jsonb().$type<string[]>().notNull(),
    // Lower bound for shard lookups (firstInteractionAt ?? createdAt of the
    // deleted contact-inbox).
    sinceTime: timestamp(timestampConfig),
    // Upper bound: the purge must only touch messages created at or before this
    // moment, so a re-created contact's new history can never be swept up.
    deletedAt: timestamp(timestampConfig).defaultNow().notNull(),
    status: messageCleanupStatus()
      .default(messageCleanupStatuses.enum.pending)
      .notNull(),
    attempts: integer().default(0).notNull(),
    lastError: text(),
    processedAt: timestamp(timestampConfig),
  },
  (table) => [
    // A sender can return with the same Page sourceId but a new contactInboxId.
    // Keep both deletion records so every shard identity is purged.
    uniqueIndex("MessageCleanup_contactInboxId_key").using(
      "btree",
      table.contactInboxId.asc().nullsLast(),
    ),
    index("MessageCleanup_status_createdAt_idx").using(
      "btree",
      table.status,
      table.createdAt,
    ),
    index("MessageCleanup_workspaceId_idx").using("btree", table.workspaceId),
  ],
)
