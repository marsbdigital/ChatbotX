import {
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest"

vi.mock("../src/lib/http-client", () => ({
  facebookGraphClient: {
    get: vi.fn(),
  },
}))

vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Dynamic imports ensure vi.mock is fully applied before loading these modules.
const { getUserPages } = await import("../src/apis/auth")
const { facebookGraphClient } = await import("../src/lib/http-client")

const mockGet = facebookGraphClient.get as MockInstance

const adminTasks = [
  "ADVERTISE",
  "ANALYZE",
  "CREATE_CONTENT",
  "MANAGE",
  "MODERATE",
]

const directPage = {
  id: "page-direct",
  name: "Direct Page",
  access_token: "direct-token",
  tasks: adminTasks,
}

// General Business Manager enumeration remains disabled. Only a caller that
// supplies both a known business and a known Page can use the reviewer fallback.
describe("getUserPages", () => {
  beforeEach(() => {
    mockGet.mockReset()
  })

  test("returns /me/accounts pages with connectability", async () => {
    mockGet.mockResolvedValueOnce({ data: [directPage] })

    const result = await getUserPages("user-token")

    expect(result).toEqual({
      pages: [{ ...directPage, isConnectable: true }],
      bmLookupFailed: false,
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith("v23.0/me/accounts", expect.anything())
  })

  test("does not call the Business Manager endpoints", async () => {
    mockGet.mockResolvedValueOnce({ data: [directPage] })

    await getUserPages("user-token")

    const endpoints = mockGet.mock.calls.map((call) => call[0])
    expect(endpoints).toEqual(["v23.0/me/accounts"])
  })

  test("paginates /me/accounts until the cursor ends", async () => {
    const directPage2 = {
      id: "page-direct-2",
      name: "Direct Page 2",
      access_token: "direct-token-2",
      tasks: adminTasks,
    }

    mockGet
      .mockResolvedValueOnce({
        data: [directPage],
        paging: {
          cursors: { after: "direct-cursor" },
          next: "https://graph.facebook.com/v23.0/me/accounts?after=direct-cursor",
        },
      })
      .mockResolvedValueOnce({ data: [directPage2] })

    const result = await getUserPages("user-token")

    expect(result.bmLookupFailed).toBe(false)
    expect(result.pages).toEqual([
      { ...directPage, isConnectable: true },
      { ...directPage2, isConnectable: true },
    ])
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(mockGet).toHaveBeenLastCalledWith("v23.0/me/accounts", {
      searchParams: expect.objectContaining({ after: "direct-cursor" }),
    })
  })

  test("classifies pages and sorts connectable pages first", async () => {
    const missingTaskPage = {
      id: "page-missing-task",
      name: "Missing Task",
      access_token: "missing-task-token",
      tasks: adminTasks.filter((task) => task !== "MODERATE"),
    }
    const emptyTasksPage = {
      id: "page-empty-tasks",
      name: "Empty Tasks",
      access_token: "empty-tasks-token",
      tasks: [],
    }
    const missingTokenPage = {
      id: "page-missing-token",
      name: "Missing Token",
      tasks: adminTasks,
    }

    mockGet.mockResolvedValueOnce({
      data: [missingTaskPage, directPage, emptyTasksPage, missingTokenPage],
    })

    const result = await getUserPages("user-token")

    expect(result.pages).toEqual([
      { ...directPage, isConnectable: true },
      { ...missingTaskPage, isConnectable: false },
      { ...emptyTasksPage, isConnectable: false },
      { ...missingTokenPage, isConnectable: false },
    ])
  })

  test("accepts a Page with a messaging task and Page token", async () => {
    const messagingPage = {
      id: "page-messaging",
      name: "Messaging Page",
      access_token: "page-token",
      tasks: ["MESSAGING"],
    }
    mockGet.mockResolvedValueOnce({ data: [messagingPage] })

    const result = await getUserPages("user-token")

    expect(result.pages).toEqual([{ ...messagingPage, isConnectable: true }])
  })

  test("retrieves only an explicitly known Page when /me/accounts is empty", async () => {
    const knownPage = {
      id: "12345",
      name: "Known Page",
      access_token: "page-token",
      tasks: ["PROFILE_PLUS_MESSAGING"],
    }
    mockGet.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce(knownPage)

    const result = await getUserPages("user-token", "v23.0", "12345")

    expect(result.pages).toEqual([{ ...knownPage, isConnectable: true }])
    expect(mockGet).toHaveBeenLastCalledWith("v23.0/12345", {
      searchParams: {
        fields: "id,name,access_token,tasks",
        access_token: "user-token",
      },
    })
  })

  test("does not query an invalid Page ID", async () => {
    mockGet.mockResolvedValueOnce({ data: [] })

    const result = await getUserPages("user-token", "v23.0", "other/page")

    expect(result.pages).toEqual([])
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  test("does not accept a different Page returned by the known-Page lookup", async () => {
    mockGet.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      ...directPage,
      id: "other-page",
    })

    const result = await getUserPages("user-token", "v23.0", "12345")

    expect(result.pages).toEqual([])
  })

  test("finds only the configured Page in the configured business", async () => {
    const reviewerPage = {
      id: "12345",
      name: "Reviewer Page",
      access_token: "reviewer-token",
    }
    mockGet
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("not directly accessible"))
      .mockResolvedValueOnce({
        data: [
          { id: "99999", name: "Other Page", access_token: "other-token" },
          reviewerPage,
        ],
      })

    const result = await getUserPages("user-token", "v23.0", "12345", "67890")

    expect(result).toEqual({
      pages: [{ ...reviewerPage, isConnectable: true }],
      bmLookupFailed: false,
    })
    expect(mockGet.mock.calls.map((call) => call[0])).toEqual([
      "v23.0/me/accounts",
      "v23.0/12345",
      "v23.0/67890/owned_pages",
    ])
  })

  test("does not query a business without valid configured IDs", async () => {
    mockGet
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("no direct Page"))

    await getUserPages("user-token", "v23.0", "bad/page", "67890")
    await getUserPages("user-token", "v23.0", "12345", "bad/business")

    expect(mockGet.mock.calls.map((call) => call[0])).toEqual([
      "v23.0/me/accounts",
      "v23.0/me/accounts",
      "v23.0/12345",
    ])
  })

  test("reports a configured business lookup failure without exposing other Pages", async () => {
    mockGet
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("no direct Page"))
      .mockRejectedValueOnce(new Error("business permission denied"))

    const result = await getUserPages("user-token", "v23.0", "12345", "67890")

    expect(result).toEqual({ pages: [], bmLookupFailed: true })
  })

  test("requests page fields with limit=100 and the user token", async () => {
    mockGet.mockResolvedValueOnce({ data: [directPage] })

    await getUserPages("user-token")

    expect(mockGet).toHaveBeenCalledWith("v23.0/me/accounts", {
      searchParams: expect.objectContaining({
        fields: "id,name,access_token,category,tasks",
        access_token: "user-token",
        limit: "100",
      }),
    })
  })
})
