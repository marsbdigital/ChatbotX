import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { db, eq, sql } from "@chatbotx.io/database/client"
import {
  attachmentModel,
  contactInboxModel,
  contactModel,
  conversationModel,
  messageCleanupModel,
  messageModel,
} from "@chatbotx.io/database/schema"
import { uploader } from "@chatbotx.io/filesystem"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import { contactService } from "../../src/contact/service"
import { messageCleanupService } from "../../src/message-cleanup/service"

// Destructive fixtures are opt-in and pinned to disposable localhost services.
// Never accepts a configurable production target.
const enabled = process.env.MBD_SYNTHETIC_DELETION_TEST === "true"
const fixtureTime = new Date("2026-01-01T00:00:00.000Z")
let sequence = 1000

describe.skipIf(!enabled)(
  "isolated synthetic deletion with real TimescaleDB and S3",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(
        "postgresql://synthetic:synthetic-local-only@127.0.0.1:55439/mbd_deletion_synthetic",
      )
      expect(process.env.S3_ENDPOINT).toBe("http://127.0.0.1:59039")
      expect(process.env.S3_BUCKET).toBe("mbd-synthetic")
      const identity = await db.execute(sql`SELECT current_database() AS name`)
      expect(identity.rows[0]?.name).toBe("mbd_deletion_synthetic")
      // A fresh schema is required. Re-running against existing records fails closed.
      const tables = await db.execute(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      )
      expect(tables.rows).toEqual([])
      await db.execute(
        sql.raw(
          readFileSync(
            new URL("./fixtures/message-cleanup.sql", import.meta.url),
            "utf8",
          ),
        ),
      )
    })

    beforeEach(async () => {
      // These are ancillary side effects; deletion, DB transactions, S3 requests,
      // shard routing and the real cleanup processor are not mocked.
      vi.spyOn(contactService, "invalidate").mockResolvedValue(undefined)
      vi.spyOn(
        contactService,
        "releaseQuotaForDeletedContacts" as never,
      ).mockResolvedValue(undefined)
      vi.stubEnv("ENABLE_PERMANENT_CONTACT_ERASURE", "true")
      await db.execute(
        sql`TRUNCATE "Contact", "ContactInbox", "Conversation", "Message", "Attachment", "MessageCleanup" CASCADE`,
      )
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    })

    afterAll(async () => {
      await db.$client.end()
    })

    async function seed(workspaceId = "91001", sourceId?: string) {
      const id = String(sequence++)
      const path = `synthetic/${id}/original.txt`
      const thumbnailPath = `synthetic/${id}/thumbnail.txt`
      const sender = sourceId ?? `synthetic-sender-${id}`
      await db
        .insert(contactModel)
        .values({ id, workspaceId, firstName: "Synthetic", lastName: id })
      await db.insert(contactInboxModel).values({
        id,
        contactId: id,
        originalContactId: id,
        inboxId: workspaceId,
        channel: "messenger",
        source: "synthetic",
        sourceId: sender,
        createdAt: fixtureTime,
        firstInteractionAt: fixtureTime,
      })
      await db
        .insert(conversationModel)
        .values({ id, workspaceId, contactId: id })
      await db.insert(messageModel).values({
        id,
        workspaceId,
        conversationId: id,
        contactInboxId: id,
        text: `Synthetic message ${id}`,
        messageType: "incoming",
        contentType: "text",
        senderType: "contact",
        createdAt: fixtureTime,
      })
      await uploader.putObject(path, `Synthetic object ${id}`)
      await uploader.putObject(thumbnailPath, `Synthetic thumbnail ${id}`)
      await db.insert(attachmentModel).values({
        id,
        workspaceId,
        conversationId: id,
        messageId: id,
        messageCreatedAt: fixtureTime,
        createdAt: fixtureTime,
        fileType: "file",
        mimeType: "text/plain",
        originPath: path,
        thumbnailPath,
      })
      return { id, workspaceId, sourceId: sender, path, thumbnailPath }
    }

    async function removeContact(record: Awaited<ReturnType<typeof seed>>) {
      const removed = await contactService.delete({
        workspaceId: record.workspaceId,
        ids: [record.id],
      })
      expect(removed.map((item) => item.id)).toEqual([record.id])
      expect(
        await db
          .select()
          .from(contactModel)
          .where(eq(contactModel.id, record.id)),
      ).toEqual([])
      expect(
        await db
          .select()
          .from(contactInboxModel)
          .where(eq(contactInboxModel.id, record.id)),
      ).toEqual([])
      expect(
        await db
          .select()
          .from(conversationModel)
          .where(eq(conversationModel.id, record.id)),
      ).toEqual([])
    }

    async function tombstone(id: string) {
      return (
        await db
          .select()
          .from(messageCleanupModel)
          .where(eq(messageCleanupModel.contactInboxId, id))
      )[0]
    }

    async function expectErased(record: Awaited<ReturnType<typeof seed>>) {
      expect(
        await db
          .select()
          .from(messageModel)
          .where(eq(messageModel.id, record.id)),
      ).toEqual([])
      expect(
        await db
          .select()
          .from(attachmentModel)
          .where(eq(attachmentModel.id, record.id)),
      ).toEqual([])
      for (const path of [record.path, record.thumbnailPath]) {
        await expect(uploader.headObject(path)).rejects.toMatchObject({
          $metadata: { httpStatusCode: 404 },
        })
      }
      expect(await tombstone(record.id)).toMatchObject({
        status: "completed",
        lastError: null,
      })
    }

    async function expectRetained(record: Awaited<ReturnType<typeof seed>>) {
      expect(
        await db
          .select()
          .from(contactModel)
          .where(eq(contactModel.id, record.id)),
      ).toHaveLength(1)
      expect(
        await db
          .select()
          .from(messageModel)
          .where(eq(messageModel.id, record.id)),
      ).toHaveLength(1)
      expect(
        await db
          .select()
          .from(attachmentModel)
          .where(eq(attachmentModel.id, record.id)),
      ).toHaveLength(1)
      expect((await uploader.getObject(record.path)).toString()).toBe(
        `Synthetic object ${record.id}`,
      )
      expect((await uploader.getObject(record.thumbnailPath)).toString()).toBe(
        `Synthetic thumbnail ${record.id}`,
      )
    }

    test("erases compressed messages and real files while preserving another workspace", async () => {
      const target = await seed()
      const control = await seed("92002")
      await db.execute(
        sql`SELECT compress_chunk(c) FROM show_chunks('"Message"') c`,
      )
      await db.execute(
        sql`SELECT compress_chunk(c) FROM show_chunks('"Attachment"') c`,
      )
      const compressed = await db.execute(
        sql`SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE is_compressed`,
      )
      expect(Number(compressed.rows[0]?.n)).toBeGreaterThanOrEqual(2)
      await removeContact(target)
      expect(await tombstone(target.id)).toMatchObject({
        status: "pending",
        attempts: 0,
      })
      expect(
        await db
          .select()
          .from(messageModel)
          .where(eq(messageModel.id, target.id)),
      ).toHaveLength(1)
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(target)
      await expectRetained(control)
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 0,
      })
    })

    test("object-store failure retains retry metadata and later erases partial deletions", async () => {
      const target = await seed()
      await removeContact(target)
      const originalDelete = uploader.deleteObject.bind(uploader)
      const fail = vi
        .spyOn(uploader, "deleteObject")
        .mockImplementation(async (path) => {
          if (path === target.thumbnailPath) {
            throw new Error("Synthetic object storage failure")
          }
          return await originalDelete(path)
        })
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 1,
      })
      expect(await tombstone(target.id)).toMatchObject({
        status: "failed",
        attempts: 1,
      })
      expect(
        await db
          .select()
          .from(messageModel)
          .where(eq(messageModel.id, target.id)),
      ).toHaveLength(1)
      expect(
        await db
          .select()
          .from(attachmentModel)
          .where(eq(attachmentModel.id, target.id)),
      ).toHaveLength(1)
      await expect(
        uploader.headObject(target.thumbnailPath),
      ).resolves.toBeDefined()
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 0,
      })
      fail.mockRestore()
      await db
        .update(messageCleanupModel)
        .set({ updatedAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(messageCleanupModel.contactInboxId, target.id))
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(target)
      expect(await tombstone(target.id)).toMatchObject({ attempts: 2 })
    })

    test("concurrent processors claim each tombstone once", async () => {
      const records = await Promise.all([seed(), seed(), seed(), seed()])
      for (const record of records) {
        await removeContact(record)
      }
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          messageCleanupService.processPending({ limit: 4 }),
        ),
      )
      expect(
        results.reduce((total, result) => total + result.processed, 0),
      ).toBe(4)
      expect(results.reduce((total, result) => total + result.failed, 0)).toBe(
        0,
      )
      for (const record of records) {
        await expectErased(record)
        expect(await tombstone(record.id)).toMatchObject({ attempts: 1 })
      }
    })

    test("shard repository retains attachment rows on object failure and completes on retry", async () => {
      const target = await seed()
      const control = await seed("92002")
      await removeContact(target)
      // Exercise the production shard-repository path without the legacy
      // conversation pass. With no external shards it routes to the main DB.
      await db
        .update(messageCleanupModel)
        .set({ conversationIds: [] })
        .where(eq(messageCleanupModel.contactInboxId, target.id))
      const originalDelete = uploader.deleteObject.bind(uploader)
      const fail = vi
        .spyOn(uploader, "deleteObject")
        .mockImplementation(async (path) => {
          if (path === target.thumbnailPath) {
            throw new Error("Synthetic shard storage failure")
          }
          return await originalDelete(path)
        })
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 1,
      })
      expect(
        await db
          .select()
          .from(messageModel)
          .where(eq(messageModel.id, target.id)),
      ).toHaveLength(1)
      expect(
        await db
          .select()
          .from(attachmentModel)
          .where(eq(attachmentModel.id, target.id)),
      ).toHaveLength(1)
      fail.mockRestore()
      await db
        .update(messageCleanupModel)
        .set({ updatedAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(messageCleanupModel.contactInboxId, target.id))
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(target)
      await expectRetained(control)
    })

    test("an older worker cannot overwrite a replacement claim in the database", async () => {
      const target = await seed()
      await removeContact(target)
      let release!: () => void
      let entered!: () => void
      const enteredPurge = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.spyOn(messageCleanupService, "purgeRow" as never).mockImplementation(
        async () => {
          entered()
          await held
        },
      )
      const older = messageCleanupService.processPending({ limit: 1 })
      try {
        await enteredPurge
        const replacementTime = new Date(Date.now() + 1000)
        await db
          .update(messageCleanupModel)
          .set({ attempts: 2, updatedAt: replacementTime })
          .where(eq(messageCleanupModel.contactInboxId, target.id))
        release()
        expect(await older).toEqual({ processed: 0, failed: 0 })
        expect(await tombstone(target.id)).toMatchObject({
          status: "processing",
          attempts: 2,
          updatedAt: replacementTime,
        })
      } finally {
        release()
        await older
      }
    })

    test("recovers a stale crashed claim but leaves a fresh claim untouched", async () => {
      const crashed = await seed()
      const active = await seed()
      await removeContact(crashed)
      await removeContact(active)
      await db
        .update(messageCleanupModel)
        .set({
          status: "processing",
          attempts: 1,
          updatedAt: new Date(Date.now() - 61 * 60_000),
        })
        .where(eq(messageCleanupModel.contactInboxId, crashed.id))
      await db
        .update(messageCleanupModel)
        .set({ status: "processing", attempts: 1, updatedAt: new Date() })
        .where(eq(messageCleanupModel.contactInboxId, active.id))
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(crashed)
      expect(await tombstone(crashed.id)).toMatchObject({ attempts: 2 })
      expect(await tombstone(active.id)).toMatchObject({
        status: "processing",
        attempts: 1,
      })
      await expect(uploader.headObject(active.path)).resolves.toBeDefined()
    })

    test("recovers after an actual worker is killed during deletion", async () => {
      const target = await seed()
      await removeContact(target)
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL("./fixtures/crash-cleanup-worker.ts", import.meta.url),
          ),
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
      )
      let stderr = ""
      child.stderr?.on("data", (data) => {
        stderr += data.toString()
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Crash worker did not claim: ${stderr}`)),
            15_000,
          )
          child.once("error", (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          child.once("exit", (code) => {
            clearTimeout(timeout)
            reject(new Error(`Crash worker exited ${code}: ${stderr}`))
          })
          child.once("message", (message) => {
            clearTimeout(timeout)
            expect(message).toEqual({ type: "claimed" })
            resolve()
          })
        })
        expect(await tombstone(target.id)).toMatchObject({
          status: "processing",
          attempts: 1,
        })
        const exit = once(child, "exit")
        child.kill("SIGKILL")
        expect(await exit).toEqual([null, "SIGKILL"])
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL")
        }
      }
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 0,
      })
      await expect(uploader.headObject(target.path)).resolves.toBeDefined()
      // Advance only this synthetic lease; no real hour-long wait is needed.
      await db
        .update(messageCleanupModel)
        .set({ updatedAt: new Date(Date.now() - 61 * 60_000) })
        .where(eq(messageCleanupModel.contactInboxId, target.id))
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(target)
      expect(await tombstone(target.id)).toMatchObject({ attempts: 2 })
    })

    test("returning sender cannot cancel old erasure and keeps its new history", async () => {
      const oldContact = await seed()
      await removeContact(oldContact)
      await messageCleanupService.cancelByInboxSource({
        inboxId: oldContact.workspaceId,
        sourceIds: [oldContact.sourceId],
      })
      const returning = await seed(oldContact.workspaceId, oldContact.sourceId)
      expect(await tombstone(oldContact.id)).toMatchObject({
        status: "pending",
      })
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(oldContact)
      await expectRetained(returning)
      await removeContact(returning)
      expect(await db.select().from(messageCleanupModel)).toHaveLength(2)
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 1,
        failed: 0,
      })
      await expectErased(returning)
    })

    test("ten exhausted attempts remain visible without another purge", async () => {
      const target = await seed()
      await removeContact(target)
      await db
        .update(messageCleanupModel)
        .set({
          status: "failed",
          attempts: 10,
          updatedAt: fixtureTime,
          lastError: "Synthetic exhausted retry",
        })
        .where(eq(messageCleanupModel.contactInboxId, target.id))
      expect(await messageCleanupService.processPending()).toEqual({
        processed: 0,
        failed: 0,
      })
      expect(await tombstone(target.id)).toMatchObject({
        status: "failed",
        attempts: 10,
      })
      await expect(uploader.headObject(target.path)).resolves.toBeDefined()
    })
  },
)
