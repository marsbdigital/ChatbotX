// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findRestrictedOwnedPage } from "../src/features/integration-messenger/libs/restricted-owned-page"

const config = {
  integrationId: "1001",
  workspaceId: "1002",
  pageId: "1003",
  appId: "1004",
  businessId: "1005",
}
const props = {
  integrationId: "1001",
  workspaceId: "1002",
  pageId: "1003",
  appId: "1004",
  version: "v25.0",
  userToken: "synthetic-user-token",
}
const page = {
  id: "1003",
  name: "Synthetic Page",
  access_token: "synthetic-page-token",
}
const fetchMock = vi.fn()
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
let replace: (url: URL) => Response | undefined

beforeEach(() => {
  vi.stubEnv("MESSENGER_RECONNECT_OWNED_PAGE_LOOKUP", JSON.stringify(config))
  vi.stubGlobal("fetch", fetchMock)
  replace = () => undefined
  fetchMock.mockReset().mockImplementation((input: URL) => {
    const url = new URL(input)
    return Promise.resolve(
      replace(url) ??
        response(
          url.pathname.endsWith("owned_pages")
            ? { data: [page] }
            : { id: "1003" },
        ),
    )
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("exact stored-Page owned-business reconnect lookup", () => {
  it("validates the returned Page token identity and returns only the stored Page", async () => {
    expect(await findRestrictedOwnedPage(props)).toEqual({
      page: { ...page, isConnectable: true },
    })
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v25.0/1005/owned_pages",
      "/v25.0/me",
    ])
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer synthetic-user-token" },
      cache: "no-store",
      redirect: "error",
    })
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      Authorization: "Bearer synthetic-page-token",
    })
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("fields")).toBe(
      "id,name,access_token",
    )
    expect(
      new URL(fetchMock.mock.calls[0][0]).searchParams.has("access_token"),
    ).toBe(false)
  })
  it.each([
    undefined,
    "",
    "null",
    "invalid-json",
    "[]",
    "{}",
    JSON.stringify({ ...config, businessId: "https://attacker.test" }),
  ])("does nothing for absent or invalid configuration: %s", async (value) => {
    vi.stubEnv("MESSENGER_RECONNECT_OWNED_PAGE_LOOKUP", value)
    expect(await findRestrictedOwnedPage(props)).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    "integrationId",
    "workspaceId",
    "pageId",
    "appId",
  ] as const)("never runs for a different %s", async (key) => {
    expect(await findRestrictedOwnedPage({ ...props, [key]: "9999" })).toEqual(
      {},
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("rejects a non-production version before any request", async () => {
    expect(
      await findRestrictedOwnedPage({ ...props, version: "v26.0" }),
    ).toEqual({ failure: "unsupportedVersion" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("never substitutes an unrelated Page from the same business", async () => {
    replace = () => response({ data: [{ ...page, id: "9999" }] })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "pageNotOwned",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...page, access_token: undefined },
    { ...page, access_token: "" },
    { ...page, name: null },
  ])("rejects a Page without a usable token/name", async (value) => {
    replace = () => response({ data: [value] })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "pageTokenMissing",
    })
  })
  it("rejects a token belonging to a different Page", async () => {
    replace = (url) =>
      url.pathname.endsWith("/me") ? response({ id: "9999" }) : undefined
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "pageIdentityMismatch",
    })
  })
  it("paginates only the configured business, ignores upstream URLs, and stops at the match", async () => {
    replace = (url) =>
      url.pathname.endsWith("owned_pages") && !url.searchParams.has("after")
        ? response({
            data: [null, { id: "9999" }],
            paging: {
              next: "https://attacker.test?access_token=synthetic-user-token",
              cursors: { after: "next-cursor" },
            },
          })
        : undefined
    expect((await findRestrictedOwnedPage(props)).page?.id).toBe("1003")
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
      "https://graph.facebook.com",
      "https://graph.facebook.com",
      "https://graph.facebook.com",
    ])
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("after")).toBe(
      "next-cursor",
    )
  })
  it.each([
    {},
    { after: "" },
  ])("rejects invalid pagination: %j", async (cursors) => {
    replace = () => response({ data: [], paging: { next: "ignored", cursors } })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "invalidPagination",
    })
  })
  it("rejects repeated cursors", async () => {
    replace = () =>
      response({
        data: [],
        paging: { next: "ignored", cursors: { after: "same" } },
      })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "invalidPagination",
    })
  })
  it("bounds traversal within the single configured business", async () => {
    let count = 0
    replace = () =>
      response({
        data: [],
        paging: { next: "ignored", cursors: { after: String(++count) } },
      })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "paginationLimit",
    })
    expect(fetchMock).toHaveBeenCalledTimes(20)
  })
  it("rejects an unexpected response shape", async () => {
    replace = () => response({ data: null })
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "invalidResponse",
    })
  })
  it("returns sanitized permission failures without token or upstream-message leakage", async () => {
    replace = () =>
      response(
        {
          error: {
            code: 200,
            message: "synthetic-user-token",
            url: "https://example.test?secret=synthetic-page-token",
          },
        },
        403,
      )
    const result = await findRestrictedOwnedPage(props)
    expect(result).toEqual({
      failure: "graphRejected",
      httpStatus: 403,
      code: 200,
    })
    expect(JSON.stringify(result)).not.toContain("synthetic-")
  })
  it("does not echo malformed error codes", async () => {
    replace = () => response({ error: { code: "synthetic-user-token" } }, 400)
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "graphRejected",
      httpStatus: 400,
      code: undefined,
    })
  })
  it("does not echo network exceptions", async () => {
    fetchMock.mockRejectedValue(
      new Error("synthetic-user-token synthetic-page-token"),
    )
    expect(await findRestrictedOwnedPage(props)).toEqual({
      failure: "requestFailed",
    })
  })
})
