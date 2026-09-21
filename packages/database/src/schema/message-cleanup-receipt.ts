import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"

/** Successful erasure evidence without a link to the erased person or files. */
export const messageCleanupReceiptModel = pgTable(
  "MessageCleanupReceipt",
  {
    ...sharedColumns,
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: bigintAsString().notNull(),
    completedAt: timestamp(timestampConfig).notNull(),
    expiresAt: timestamp(timestampConfig).notNull(),
    attempts: integer().notNull(),
    implementationVersion: text().notNull(),
  },
  (table) => [
    index("MessageCleanupReceipt_expiresAt_idx").on(table.expiresAt),
    index("MessageCleanupReceipt_workspaceId_idx").on(table.workspaceId),
  ],
)
