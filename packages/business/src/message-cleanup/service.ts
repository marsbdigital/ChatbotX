import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  inArray,
  liftDecompressionLimit,
  lt,
  lte,
  or,
  sql,
} from "@chatbotx.io/database/client"
import { messageCleanupStatuses } from "@chatbotx.io/database/partials"
import {
  attachmentModel,
  messageCleanupModel,
  messageCleanupReceiptModel,
  messageModel,
} from "@chatbotx.io/database/schema"
import type { MessageCleanupModel } from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import { BaseService } from "../base.service"
import { logger } from "../logger"
import { messageService } from "../message/service"

export type MessageCleanupEntry = {
  contactId: string
  contactInboxId: string
  inboxId: string
  sourceId: string
  conversationIds: string[]
  sinceTime: Date
}

// Concurrent multi-row upserts/deletes on the same unique key must lock rows
// in a consistent order, or overlapping batches can deadlock.
const byContactInboxId = (
  a: { contactInboxId: string },
  b: { contactInboxId: string },
): number => a.contactInboxId.localeCompare(b.contactInboxId)

const PROCESS_DEFAULT_LIMIT = 100
const CONVERSATION_DELETE_BATCH_SIZE = 100
const MAX_ATTEMPTS = 10
const FAILED_RETRY_DELAY_MS = 30 * 60 * 1000
const STALE_PROCESSING_DELAY_MS = 60 * 60 * 1000
const CLAIM_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RECEIPT_IMPLEMENTATION_VERSION = "mbd-erasure-v2"

/**
 * Tracks Message/Attachment rows orphaned by contact deletes.
 *
 * Message/Attachment are compressed TimescaleDB hypertables with no FKs, so a
 * contact delete leaves their rows behind and records one tombstone per
 * deleted contact-inbox here. The actual purge (`processPending`) is
 * scheduled by the worker only when its explicit rollout flag is enabled.
 */
class MessageCleanupService extends BaseService {
  /**
   * Upserts one tombstone per deleted contact-inbox. Must run in the same
   * transaction as the contact delete so tombstones and deletes can never
   * diverge. Repeating the same deleted contact-inbox updates its existing
   * tombstone, but a re-created contact gets its own shard identity and row.
   */
  async record(props: {
    workspaceId: string
    entries: MessageCleanupEntry[]
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, entries, tx = db } = props
    if (entries.length === 0) {
      return
    }

    await tx
      .insert(messageCleanupModel)
      .values(
        [...entries].sort(byContactInboxId).map((entry) => ({
          workspaceId,
          contactId: entry.contactId,
          contactInboxId: entry.contactInboxId,
          inboxId: entry.inboxId,
          sourceId: entry.sourceId,
          conversationIds: entry.conversationIds,
          sinceTime: entry.sinceTime,
        })),
      )
      .onConflictDoUpdate({
        target: [messageCleanupModel.contactInboxId],
        set: {
          contactId: sql`excluded."contactId"`,
          conversationIds: sql`(
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements_text(
              ${messageCleanupModel.conversationIds} || excluded."conversationIds"
            )
          )`,
          sinceTime: sql`least(${messageCleanupModel.sinceTime}, excluded."sinceTime")`,
          deletedAt: sql`now()`,
          status: messageCleanupStatuses.enum.pending,
          attempts: 0,
          lastError: null,
          processedAt: null,
          updatedAt: sql`now()`,
        },
      })
  }

  /**
   * Legacy behavior: a returning contact keeps old history. For installations
   * where Delete Contact is an erasure operation, leave tombstones intact; a
   * new contact-inbox has a different id, so its new messages are unaffected.
   */
  async cancelByInboxSource(props: {
    inboxId: string
    sourceIds: string[]
    tx?: DatabaseClient
  }): Promise<void> {
    const { inboxId, sourceIds, tx = db } = props
    if (process.env.ENABLE_PERMANENT_CONTACT_ERASURE === "true") {
      return
    }
    if (sourceIds.length === 0) {
      return
    }

    await tx
      .delete(messageCleanupModel)
      .where(
        and(
          eq(messageCleanupModel.inboxId, inboxId),
          inArray(messageCleanupModel.sourceId, [...sourceIds].sort()),
        ),
      )
  }

  /**
   * Purges the orphaned messages/attachments recorded by `record`.
   *
   * A failed object-store operation is retried after a delay. A processing row
   * left by a crashed worker is eligible again after an hour; every delete is
   * bounded to the original contact's IDs and deletion timestamp.
   */
  async processPending(props?: { limit?: number }): Promise<{
    processed: number
    failed: number
  }> {
    const limit = props?.limit ?? PROCESS_DEFAULT_LIMIT
    const retryAfter = new Date(Date.now() - FAILED_RETRY_DELAY_MS)
    const staleAfter = new Date(Date.now() - STALE_PROCESSING_DELAY_MS)

    let processed = 0
    let failed = 0
    for (let i = 0; i < limit; i += 1) {
      // Claim each row immediately before purging it. Claiming an entire batch
      // would make later rows look stale while they wait behind earlier work.
      const row = await db.transaction(async (tx) => {
        const [next] = await tx
          .select()
          .from(messageCleanupModel)
          .where(
            or(
              eq(messageCleanupModel.status, "pending"),
              and(
                eq(messageCleanupModel.status, "failed"),
                lt(messageCleanupModel.attempts, MAX_ATTEMPTS),
                lte(messageCleanupModel.updatedAt, retryAfter),
              ),
              and(
                eq(messageCleanupModel.status, "processing"),
                lt(messageCleanupModel.attempts, MAX_ATTEMPTS),
                lte(messageCleanupModel.updatedAt, staleAfter),
              ),
            ),
          )
          .orderBy(asc(messageCleanupModel.createdAt))
          .limit(1)
          .for("update", { skipLocked: true })

        if (!next) {
          return null
        }

        const [claimed] = await tx
          .update(messageCleanupModel)
          .set({
            status: messageCleanupStatuses.enum.processing,
            attempts: sql`${messageCleanupModel.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(messageCleanupModel.id, next.id))
          .returning()
        return claimed ?? null
      })

      if (!row) {
        break
      }

      const claim = { updatedAt: row.updatedAt }
      const ownsClaim = () =>
        and(
          eq(messageCleanupModel.id, row.id),
          eq(messageCleanupModel.status, "processing"),
          eq(messageCleanupModel.updatedAt, claim.updatedAt),
        )
      try {
        await this.purgeWithHeartbeat(row, claim)
        const completed = await db.transaction(async (tx) => {
          const [removed] = await tx
            .delete(messageCleanupModel)
            .where(ownsClaim())
            .returning({ workspaceId: messageCleanupModel.workspaceId })
          if (!removed) {
            return false
          }
          const completedAt = new Date()
          await tx.insert(messageCleanupReceiptModel).values({
            workspaceId: removed.workspaceId,
            completedAt,
            expiresAt: new Date(completedAt.getTime() + RECEIPT_RETENTION_MS),
            attempts: row.attempts,
            implementationVersion: RECEIPT_IMPLEMENTATION_VERSION,
          })
          return true
        })
        if (completed) {
          processed += 1
        }
      } catch {
        // Storage/database errors can embed sender identifiers, object paths,
        // SQL parameters or credentials. Keep only a stable failure category
        // and the operational job reference; the queue retains retry selectors.
        logger.error(
          {
            errorCategory: "PURGE_FAILED",
            messageCleanupId: row.id,
            workspaceId: row.workspaceId,
          },
          "Message cleanup purge failed",
        )
        const markedFailed = await db
          .update(messageCleanupModel)
          .set({
            status: messageCleanupStatuses.enum.failed,
            lastError: "PURGE_FAILED",
          })
          .where(ownsClaim())
          .returning({ id: messageCleanupModel.id })
        if (markedFailed.length > 0) {
          failed += 1
        }
      }
    }

    return { processed, failed }
  }

  /** Operator report intentionally excludes sender, conversation and file selectors. */
  async operatorStatus() {
    const counts = await db
      .select({
        status: messageCleanupModel.status,
        count: sql<number>`count(*)::int`,
      })
      .from(messageCleanupModel)
      .groupBy(messageCleanupModel.status)
    const jobs = await db
      .select({
        id: messageCleanupModel.id,
        workspaceId: messageCleanupModel.workspaceId,
        status: messageCleanupModel.status,
        attempts: messageCleanupModel.attempts,
        updatedAt: messageCleanupModel.updatedAt,
      })
      .from(messageCleanupModel)
      .where(
        or(
          eq(messageCleanupModel.status, "failed"),
          and(
            eq(messageCleanupModel.status, "processing"),
            lte(
              messageCleanupModel.updatedAt,
              new Date(Date.now() - STALE_PROCESSING_DELAY_MS),
            ),
          ),
        ),
      )
      .orderBy(asc(messageCleanupModel.updatedAt))
      .limit(100)
    return { counts, jobs }
  }

  /** Operator-only callers must authorize before invoking this service. */
  async retryExhausted(id: string): Promise<boolean> {
    const retried = await db
      .update(messageCleanupModel)
      .set({
        status: "pending",
        attempts: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageCleanupModel.id, id),
          sql`${messageCleanupModel.attempts} >= ${MAX_ATTEMPTS}`,
          or(
            eq(messageCleanupModel.status, "failed"),
            and(
              eq(messageCleanupModel.status, "processing"),
              lte(
                messageCleanupModel.updatedAt,
                new Date(Date.now() - STALE_PROCESSING_DELAY_MS),
              ),
            ),
          ),
        ),
      )
      .returning({ id: messageCleanupModel.id })
    return retried.length === 1
  }

  /** Bounded maintenance; never discards pending, processing or failed work. */
  async maintainReceipts(limit = 1000): Promise<{
    minimized: number
    expired: number
    exhausted: number
  }> {
    const now = new Date()
    const minimized = await db.transaction(async (tx) => {
      const legacy = await tx
        .select()
        .from(messageCleanupModel)
        .where(eq(messageCleanupModel.status, "completed"))
        .orderBy(asc(messageCleanupModel.id))
        .limit(limit)
        .for("update", { skipLocked: true })
      for (const row of legacy) {
        const completedAt = row.processedAt ?? row.updatedAt
        const expiresAt = new Date(completedAt.getTime() + RECEIPT_RETENTION_MS)
        if (expiresAt > now) {
          await tx.insert(messageCleanupReceiptModel).values({
            workspaceId: row.workspaceId,
            completedAt,
            expiresAt,
            attempts: row.attempts,
            implementationVersion: "mbd-erasure-v1-legacy",
          })
        }
        await tx
          .delete(messageCleanupModel)
          .where(eq(messageCleanupModel.id, row.id))
      }
      return legacy.length
    })
    const expired = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: messageCleanupReceiptModel.id })
        .from(messageCleanupReceiptModel)
        .where(lte(messageCleanupReceiptModel.expiresAt, now))
        .orderBy(asc(messageCleanupReceiptModel.expiresAt))
        .limit(limit)
        .for("update", { skipLocked: true })
      if (rows.length > 0) {
        await tx.delete(messageCleanupReceiptModel).where(
          inArray(
            messageCleanupReceiptModel.id,
            rows.map((row) => row.id),
          ),
        )
      }
      return rows.length
    })
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messageCleanupModel)
      .where(
        and(
          sql`${messageCleanupModel.attempts} >= ${MAX_ATTEMPTS}`,
          or(
            eq(messageCleanupModel.status, "failed"),
            and(
              eq(messageCleanupModel.status, "processing"),
              lte(
                messageCleanupModel.updatedAt,
                new Date(now.getTime() - STALE_PROCESSING_DELAY_MS),
              ),
            ),
          ),
        ),
      )
    return { minimized, expired, exhausted: result?.count ?? 0 }
  }

  private async purgeWithHeartbeat(
    row: MessageCleanupModel,
    claim: { updatedAt: Date },
  ): Promise<void> {
    // A slow object store or large shard purge must not make a healthy worker
    // appear crashed. Keep its lease fresh, but let the original worker lose
    // ownership if another worker already recovered a genuinely stale claim.
    let heartbeatError: unknown = null
    let renewal = Promise.resolve()
    const timer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          if (heartbeatError) {
            return
          }
          const [renewed] = await db
            .update(messageCleanupModel)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(messageCleanupModel.id, row.id),
                eq(messageCleanupModel.status, "processing"),
                eq(messageCleanupModel.updatedAt, claim.updatedAt),
              ),
            )
            .returning({ updatedAt: messageCleanupModel.updatedAt })
          if (!renewed) {
            throw new Error(
              `Message cleanup claim ${row.id} is no longer owned`,
            )
          }
          claim.updatedAt = renewed.updatedAt
        })
        .catch((error: unknown) => {
          heartbeatError = error
        })
    }, CLAIM_HEARTBEAT_INTERVAL_MS)

    try {
      await this.purgeRow(row)
    } finally {
      clearInterval(timer)
      await renewal
    }
    if (heartbeatError) {
      throw heartbeatError
    }
  }

  private async purgeRow(row: MessageCleanupModel): Promise<void> {
    // Main-DB hypertables: bound every statement by conversationId (the
    // compression segmentby column) and by the delete moment, so a re-created
    // contact's newer rows can never be swept up. `liftDecompressionLimit`
    // clears the TimescaleDB decompression cap for each transaction only.
    for (
      let i = 0;
      i < row.conversationIds.length;
      i += CONVERSATION_DELETE_BATCH_SIZE
    ) {
      const batch = row.conversationIds.slice(
        i,
        i + CONVERSATION_DELETE_BATCH_SIZE,
      )
      await db.transaction(async (tx) => {
        await liftDecompressionLimit(tx)

        const attachments = await tx
          .select({
            originPath: attachmentModel.originPath,
            thumbnailPath: attachmentModel.thumbnailPath,
          })
          .from(attachmentModel)
          .where(
            and(
              inArray(attachmentModel.conversationId, batch),
              lte(attachmentModel.createdAt, row.deletedAt),
            ),
          )
        const paths = attachments.flatMap((attachment) =>
          [attachment.originPath, attachment.thumbnailPath].filter(
            (path): path is string => Boolean(path),
          ),
        )
        // Keep the DB rows available for a retry if an object deletion fails.
        await Promise.all(
          [...new Set(paths)].map((path) => uploader.deleteObject(path)),
        )

        await tx
          .delete(messageModel)
          .where(
            and(
              inArray(messageModel.conversationId, batch),
              lte(messageModel.createdAt, row.deletedAt),
            ),
          )
        await tx
          .delete(attachmentModel)
          .where(
            and(
              inArray(attachmentModel.conversationId, batch),
              lte(attachmentModel.createdAt, row.deletedAt),
            ),
          )
      })
    }

    // Shard DBs: the deleted contact-inbox id can never be re-assigned, so the
    // sinceTime lower bound is enough.
    await messageService.hardDeleteAllByContactInbox({
      contactInboxId: row.contactInboxId,
      sinceTime: row.sinceTime ?? row.createdAt,
      workspaceId: row.workspaceId,
      beforeDeleteAttachments: async (paths) => {
        await Promise.all(paths.map((path) => uploader.deleteObject(path)))
      },
    })
  }
}

export const messageCleanupService = new MessageCleanupService()
