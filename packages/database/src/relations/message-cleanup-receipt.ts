import { defineRelationsPart } from "drizzle-orm"
import { messageCleanupReceiptModel } from "../schema"

// Receipts outlive workspace removal and deliberately have no person/job link.
export const messageCleanupReceiptRelations = defineRelationsPart(
  { messageCleanupReceiptModel },
  () => ({
    messageCleanupReceiptModel: {},
  }),
)
