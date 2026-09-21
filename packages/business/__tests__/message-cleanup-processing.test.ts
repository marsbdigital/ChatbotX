// @vitest-environment node

import { db } from "@chatbotx.io/database/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { messageCleanupService } from "../src/message-cleanup/service"

type Claim = {
  id: string
  attempts: number
  updatedAt: Date
}

function mockClaims(rows: Claim[], completed: boolean) {
  const pending = [...rows]
  let selected: Claim | undefined
  const events: string[] = []
  const tx = {
    delete: vi.fn(() => ({
      where: () => ({
        returning: () => {
          events.push("finish")
          return Promise.resolve(completed ? [{ workspaceId: "1" }] : [])
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: () => {
        events.push("receipt")
        return Promise.resolve()
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: () => {
                selected = pending.shift()
                events.push(`select:${selected?.id ?? "none"}`)
                return Promise.resolve(selected ? [selected] : [])
              },
            }),
          }),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => {
            events.push(`claim:${selected?.id}`)
            return Promise.resolve(selected ? [selected] : [])
          },
        }),
      }),
    })),
  }

  vi.spyOn(db, "transaction").mockImplementation(async (callback) =>
    callback(tx as never),
  )
  vi.spyOn(db, "update").mockImplementation(
    () =>
      ({
        set: () => ({
          where: () => ({
            returning: () => {
              events.push("finish")
              return Promise.resolve(completed ? [{ id: "done" }] : [])
            },
          }),
        }),
      }) as never,
  )

  return events
}

describe("message cleanup claim ownership", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test("claims each row only when it is ready to purge", async () => {
    const events = mockClaims(
      [
        { id: "1", attempts: 1, updatedAt: new Date("2026-09-20") },
        { id: "2", attempts: 1, updatedAt: new Date("2026-09-20") },
      ],
      true,
    )
    vi.spyOn(messageCleanupService, "purgeRow" as never).mockImplementation(
      (row: Claim) => {
        events.push(`purge:${row.id}`)
        return Promise.resolve()
      },
    )

    const result = await messageCleanupService.processPending({ limit: 2 })

    expect(result).toEqual({ processed: 2, failed: 0 })
    expect(events).toEqual([
      "select:1",
      "claim:1",
      "purge:1",
      "finish",
      "receipt",
      "select:2",
      "claim:2",
      "purge:2",
      "finish",
      "receipt",
    ])
  })

  test("does not claim completion after another worker takes the lease", async () => {
    const events = mockClaims(
      [{ id: "1", attempts: 2, updatedAt: new Date("2026-09-20") }],
      false,
    )
    vi.spyOn(messageCleanupService, "purgeRow" as never).mockResolvedValue(
      undefined,
    )

    const result = await messageCleanupService.processPending({ limit: 1 })

    expect(result).toEqual({ processed: 0, failed: 0 })
    expect(events).not.toContain("receipt")
  })

  test("records a purge failure only when it still owns the lease", async () => {
    mockClaims(
      [{ id: "1", attempts: 1, updatedAt: new Date("2026-09-20") }],
      true,
    )
    vi.spyOn(messageCleanupService, "purgeRow" as never).mockRejectedValue(
      new Error("storage unavailable"),
    )

    const result = await messageCleanupService.processPending({ limit: 1 })

    expect(result).toEqual({ processed: 0, failed: 1 })
  })

  test("renews a slow purge claim before the stale-worker timeout", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"))
    mockClaims(
      [{ id: "1", attempts: 1, updatedAt: new Date("2026-09-20T12:00:00Z") }],
      true,
    )
    let finishPurge!: () => void
    const purging = new Promise<void>((resolve) => {
      finishPurge = resolve
    })
    vi.spyOn(messageCleanupService, "purgeRow" as never).mockReturnValue(
      purging,
    )
    const updates = vi.spyOn(db, "update")
    updates.mockImplementation(
      () =>
        ({
          set: () => ({
            where: () => ({
              returning: async () => [
                {
                  id: "1",
                  updatedAt: new Date(Date.now()),
                },
              ],
            }),
          }),
        }) as never,
    )

    const resultPromise = messageCleanupService.processPending({ limit: 1 })
    await vi.waitFor(() => {
      expect(messageCleanupService.purgeRow).toHaveBeenCalledOnce()
    })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(updates).toHaveBeenCalledTimes(1)
    finishPurge()
    expect(await resultPromise).toEqual({ processed: 1, failed: 0 })
    expect(updates).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
