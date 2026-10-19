// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isMessengerReconnectDiagnostic,
  runMessengerReconnectDiagnostic,
} from "../src/features/integration-messenger/libs/reconnect-diagnostic"

const VERSION_PATH_PATTERN = /^\/v25\.0\//
const fetchMock = vi.fn()
const props = {
  credentialConfig: {
    clientId: "1001",
    clientSecret: "synthetic-secret",
    version: "v25.0",
  },
  code: "synthetic-code",
  callbackUrl: "https://public.example.test/integrations/messenger/callback",
  pageId: "1002",
}
let override: (path: string, url: URL) => Response | undefined

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
function wire() {
  fetchMock.mockImplementation((input: URL) => {
    const url = new URL(input)
    const path = url.pathname.slice("/v25.0/".length)
    const replaced = override(path, url)
    if (replaced) {
      return Promise.resolve(replaced)
    }
    if (path === "oauth/access_token") {
      return Promise.resolve(response({ access_token: "synthetic-token" }))
    }
    if (path === "debug_token") {
      return Promise.resolve(
        response({
          data: {
            app_id: "1001",
            is_valid: true,
            issued_at: 1234,
            scopes: [
              "pages_show_list",
              "business_management",
              "pages_messaging",
              "pages_manage_metadata",
            ],
            granular_scopes: [
              { scope: "pages_messaging", target_ids: ["1002"] },
            ],
          },
        }),
      )
    }
    if (path === "me/permissions") {
      return Promise.resolve(
        response({
          data: [{ permission: "pages_messaging", status: "granted" }],
        }),
      )
    }
    if (path === "me/accounts") {
      return Promise.resolve(
        response({
          data: [
            {
              id: "1002",
              name: "Synthetic Page",
              tasks: ["MANAGE", "MESSAGING"],
              access_token: "synthetic-page-token",
            },
          ],
        }),
      )
    }
    if (path === "me/businesses") {
      return Promise.resolve(
        response({ data: [{ id: "1003", name: "Synthetic Business" }] }),
      )
    }
    return Promise.resolve(
      response({
        data: [{ id: "1002", access_token: "synthetic-owned-token" }],
      }),
    )
  })
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_RECONNECT_DIAGNOSTIC_INTEGRATION_IDS", "")
  vi.stubEnv("MESSENGER_RECONNECT_DIAGNOSTIC_BUSINESS_ID", "1003")
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  override = () => undefined
  wire()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("integration-specific diagnostic gate", () => {
  it("is disabled by default and never prefix-matches", () => {
    expect(isMessengerReconnectDiagnostic("1001")).toBe(false)
    vi.stubEnv("MESSENGER_RECONNECT_DIAGNOSTIC_INTEGRATION_IDS", " 1001, 1002 ")
    expect(isMessengerReconnectDiagnostic("1001")).toBe(true)
    expect(isMessengerReconnectDiagnostic("1002")).toBe(true)
    expect(isMessengerReconnectDiagnostic("10010")).toBe(false)
    expect(isMessengerReconnectDiagnostic("not-an-id")).toBe(false)
  })
  it("handles an unset gate", () => {
    vi.stubEnv("MESSENGER_RECONNECT_DIAGNOSTIC_INTEGRATION_IDS", undefined)
    expect(isMessengerReconnectDiagnostic("1001")).toBe(false)
  })
})

describe("read-only in-memory token diagnostic", () => {
  it("uses v25 GETs, retains no tokens in output, and reports only safe metadata", async () => {
    const report = await runMessengerReconnectDiagnostic(props)
    expect(report).toMatchObject({
      version: "v25.0",
      targetPageId: "1002",
      targetBusinessId: "1003",
      token: {
        appId: "1001",
        valid: true,
        issuedAt: 1234,
        targets: [{ scope: "pages_messaging", ids: ["1002"] }],
      },
      pages: {
        complete: true,
        values: [
          { id: "1002", tasks: ["MANAGE", "MESSAGING"], tokenPresent: true },
        ],
      },
    })
    const serialized = JSON.stringify(report)
    for (const forbidden of [
      props.code,
      props.credentialConfig.clientSecret,
      "synthetic-token",
      "synthetic-page-token",
      "synthetic-owned-token",
      "Synthetic Page",
      "Synthetic Business",
      "https://",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url).origin).toBe("https://graph.facebook.com")
      expect(new URL(url).pathname).toMatch(VERSION_PATH_PATTERN)
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        redirect: "error",
      })
    }
  })
  it.each([
    { version: "v26.0" },
    { pageId: "invalid" },
    { businessId: "invalid" },
  ])("fails closed for invalid configuration: %j", async (change) => {
    if (change.businessId) {
      vi.stubEnv(
        "MESSENGER_RECONNECT_DIAGNOSTIC_BUSINESS_ID",
        change.businessId,
      )
    }
    expect(
      await runMessengerReconnectDiagnostic({
        ...props,
        pageId: change.pageId ?? props.pageId,
        credentialConfig: {
          ...props.credentialConfig,
          version: change.version ?? "v25.0",
        },
      }),
    ).toEqual({ failure: "invalidDiagnosticConfiguration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("redacts all upstream error text and URLs", async () => {
    override = (path) =>
      path === "oauth/access_token"
        ? response(
            {
              error: {
                code: 190,
                error_subcode: 463,
                message: "synthetic-secret synthetic-code synthetic-token",
                url: "https://example.test?token=synthetic-token",
              },
            },
            400,
          )
        : undefined
    expect(await runMessengerReconnectDiagnostic(props)).toEqual({
      version: "v25.0",
      failure: "codeExchangeFailed",
      error: { httpStatus: 400, code: 190, subcode: 463 },
    })
  })
  it("handles network exceptions without serializing them", async () => {
    fetchMock.mockRejectedValue(new Error("synthetic-secret synthetic-code"))
    expect(await runMessengerReconnectDiagnostic(props)).toEqual({
      version: "v25.0",
      failure: "codeExchangeFailed",
      error: { failure: "requestFailed" },
    })
  })
  it("handles an exchange response without a token", async () => {
    override = (path) =>
      path === "oauth/access_token" ? response({}) : undefined
    expect(await runMessengerReconnectDiagnostic(props)).toEqual({
      version: "v25.0",
      failure: "codeExchangeFailed",
      error: undefined,
    })
  })
  it("falls back to the fresh short-lived token if long-lived exchange fails", async () => {
    override = (path, url) =>
      path === "oauth/access_token" && url.searchParams.has("grant_type")
        ? response({ error: { code: 100 } }, 400)
        : undefined
    const report = await runMessengerReconnectDiagnostic(props)
    expect(report.longLivedExchange).toMatchObject({
      succeeded: false,
      error: { code: 100 },
    })
    expect(
      fetchMock.mock.calls.find(([url]) =>
        new URL(url).pathname.endsWith("me/accounts"),
      )?.[1].headers,
    ).toEqual({ Authorization: "Bearer synthetic-token" })
  })
  it("reports a business denial without changing any permission", async () => {
    override = (path) =>
      path === "1003/owned_pages"
        ? response(
            { error: { code: 200, message: "do not log this raw error" } },
            403,
          )
        : undefined
    expect((await runMessengerReconnectDiagnostic(props)).ownedPages).toEqual({
      values: [],
      complete: false,
      error: { httpStatus: 403, code: 200, subcode: undefined },
    })
  })
  it("paginates using cursors rather than upstream token-bearing URLs", async () => {
    override = (path, url) =>
      path === "me/accounts"
        ? response(
            url.searchParams.has("after")
              ? { data: [{ id: "1002" }] }
              : {
                  data: [],
                  paging: {
                    next: "https://attacker.test?access_token=synthetic-token",
                    cursors: { after: "next-cursor" },
                  },
                },
          )
        : undefined
    expect((await runMessengerReconnectDiagnostic(props)).pages).toEqual({
      values: [{ id: "1002", tasks: [], tokenPresent: false }],
      complete: true,
      error: undefined,
    })
    expect(
      fetchMock.mock.calls.every(
        ([url]) => new URL(url).origin === "https://graph.facebook.com",
      ),
    ).toBe(true)
  })
  it.each([
    {},
    { after: "" },
  ])("fails closed on invalid pagination: %j", async (cursors) => {
    override = (path) =>
      path === "me/accounts"
        ? response({ data: [], paging: { next: "ignored", cursors } })
        : undefined
    expect((await runMessengerReconnectDiagnostic(props)).pages).toMatchObject({
      complete: false,
      error: { failure: "invalidPagination" },
    })
  })
  it("bounds pagination", async () => {
    let count = 0
    override = (path) =>
      path === "me/accounts"
        ? response({
            data: [],
            paging: { next: "ignored", cursors: { after: String(++count) } },
          })
        : undefined
    expect((await runMessengerReconnectDiagnostic(props)).pages).toMatchObject({
      complete: false,
      error: { failure: "paginationLimit" },
    })
    expect(count).toBe(20)
  })
  it("does not serialize unexpected response shapes or unsafe field values", async () => {
    override = (path) => {
      if (path === "debug_token") {
        return response({
          data: {
            app_id: "synthetic-token",
            is_valid: false,
            issued_at: "synthetic-token",
            scopes: ["synthetic-token", 1],
            granular_scopes: [
              { scope: "synthetic-token", target_ids: ["synthetic-token"] },
            ],
          },
        })
      }
      if (path === "me/accounts") {
        return response({
          data: [
            null,
            { id: "synthetic-token", tasks: "synthetic-token" },
            { id: "1002", tasks: ["synthetic-token"], access_token: 1 },
          ],
        })
      }
      if (path === "me/businesses") {
        return response({ data: {} })
      }
      if (path === "me/permissions") {
        return response({
          data: [
            { permission: "synthetic-token", status: "synthetic-token" },
            { permission: "pages_messaging", status: "unexpected" },
          ],
        })
      }
      return
    }
    const report = await runMessengerReconnectDiagnostic(props)
    expect(JSON.stringify(report)).not.toContain("synthetic-token")
    expect(report.permissions).toMatchObject({
      values: [{ permission: "pages_messaging", status: "unknown" }],
    })
  })
  it("returns safe metadata even when debug-token fails", async () => {
    override = (path) =>
      path === "debug_token"
        ? response({ error: { code: 190 } }, 400)
        : undefined
    expect((await runMessengerReconnectDiagnostic(props)).token).toMatchObject({
      valid: false,
      scopes: [],
      targets: [],
      error: { code: 190 },
    })
  })
})
