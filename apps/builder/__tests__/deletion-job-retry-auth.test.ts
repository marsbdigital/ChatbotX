import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  user: null as null | { email: string; mustChangePassword: boolean },
  retry: vi.fn(async () => true),
  revalidate: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  isSuperAdmin: (user: { email: string }) =>
    user.email === "operator@example.test",
  messageCleanupService: { retryExhausted: state.retry },
}))
vi.mock("@/lib/auth/utils", () => ({ getCurrentUser: async () => state.user }))
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND")
  },
  redirect: () => {
    throw new Error("PASSWORD_CHANGE_REQUIRED")
  },
}))
const { retryCleanup } = await import(
  "../src/features/admin/actions/retry-cleanup"
)

beforeEach(() => {
  state.user = null
  vi.clearAllMocks()
})
const form = (id = "12345") => {
  const value = new FormData()
  value.set("id", id)
  return value
}

test("anonymous and reviewer users cannot retry platform deletion jobs", async () => {
  await expect(retryCleanup(form())).rejects.toThrow("NOT_FOUND")
  state.user = { email: "reviewer@example.test", mustChangePassword: false }
  await expect(retryCleanup(form())).rejects.toThrow("NOT_FOUND")
  expect(state.retry).not.toHaveBeenCalled()
})
test("temporary-password operators must change their password first", async () => {
  state.user = { email: "operator@example.test", mustChangePassword: true }
  await expect(retryCleanup(form())).rejects.toThrow("PASSWORD_CHANGE_REQUIRED")
  expect(state.retry).not.toHaveBeenCalled()
})
test("invalid IDs cannot reach the retry service", async () => {
  state.user = { email: "operator@example.test", mustChangePassword: false }
  await expect(retryCleanup(form("123 OR 1=1"))).rejects.toThrow()
  expect(state.retry).not.toHaveBeenCalled()
})
test("authenticated operator can request a retry and refresh the status page", async () => {
  state.user = { email: "operator@example.test", mustChangePassword: false }
  await retryCleanup(form())
  expect(state.retry).toHaveBeenCalledExactlyOnceWith("12345")
  expect(state.revalidate).toHaveBeenCalledExactlyOnceWith(
    "/admin/deletion-jobs",
  )
})
