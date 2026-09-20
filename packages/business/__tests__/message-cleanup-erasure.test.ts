// @vitest-environment node

import { db } from "@chatbotx.io/database/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { messageCleanupService } from "../src/message-cleanup/service"

describe("contact history after re-creation", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test("a returning sender cannot cancel erasure when permanent deletion is enabled", async () => {
    vi.stubEnv("ENABLE_PERMANENT_CONTACT_ERASURE", "true")
    const deleteRows = vi.spyOn(db, "delete")

    await messageCleanupService.cancelByInboxSource({
      inboxId: "page-1",
      sourceIds: ["sender-1"],
    })

    expect(deleteRows).not.toHaveBeenCalled()
  })

  test("legacy history-preservation behavior stays available by default", async () => {
    vi.stubEnv("ENABLE_PERMANENT_CONTACT_ERASURE", "false")
    const where = vi.fn().mockResolvedValue(undefined)
    const deleteRows = vi
      .spyOn(db, "delete")
      .mockReturnValue({ where } as never)

    await messageCleanupService.cancelByInboxSource({
      inboxId: "page-1",
      sourceIds: ["sender-1"],
    })

    expect(deleteRows).toHaveBeenCalledTimes(1)
    expect(where).toHaveBeenCalledTimes(1)
  })
})
