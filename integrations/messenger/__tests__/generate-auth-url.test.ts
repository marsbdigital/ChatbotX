import { afterEach, describe, expect, test, vi } from "vitest"
import { generateAuthUrl } from "../src/apis/auth"

// URL generation does not need network clients or the application runtime.
vi.mock("@chatbotx.io/utils", () => ({ fetchAllCursorPages: vi.fn() }))
vi.mock("../src/exception", () => ({ rescue: vi.fn() }))
vi.mock("../src/lib/http-client", () => ({ facebookGraphClient: {} }))
vi.mock("../src/lib/logger", () => ({ logger: {} }))

describe("generateAuthUrl", () => {
  afterEach(() => vi.unstubAllEnvs())

  test("asks Facebook to rerequest previously declined permissions", () => {
    const authUrl = generateAuthUrl({
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
      stateParams: { workspaceId: "workspace-id" },
    })

    expect(new URL(authUrl).searchParams.get("auth_type")).toBe("rerequest")
  })

  test("limits the configured app to the approved Messenger permissions", () => {
    vi.stubEnv("MESSENGER_OAUTH_MESSAGING_ONLY_APP_IDS", "approved-app")
    const url = new URL(
      generateAuthUrl({
        clientId: "approved-app",
        version: "v25.0",
        redirectUrl: "https://example.com/integrations/messenger/callback",
        stateParams: {
          workspaceId: "10000000000000001",
          reconnectIntegrationId: "10000000000000002",
        },
      }),
    )
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "pages_manage_metadata",
      "pages_messaging",
      "pages_show_list",
      "business_management",
    ])
    expect(url.searchParams.get("client_id")).toBe("approved-app")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/integrations/messenger/callback",
    )
    expect(url.pathname).toBe("/v25.0/dialog/oauth")
    expect(url.searchParams.get("auth_type")).toBe("rerequest")
    expect(
      JSON.parse(
        Buffer.from(url.searchParams.get("state") ?? "", "base64").toString(),
      ),
    ).toEqual({
      workspaceId: "10000000000000001",
      reconnectIntegrationId: "10000000000000002",
    })
  })

  test("preserves the existing full scope request for an unrelated app", () => {
    vi.stubEnv("MESSENGER_OAUTH_MESSAGING_ONLY_APP_IDS", "approved-app")
    const url = new URL(
      generateAuthUrl({
        clientId: "unrelated-app",
        redirectUrl: "https://example.com/callback",
      }),
    )
    expect(url.searchParams.get("scope")?.split(",")).toContain(
      "pages_manage_ads",
    )
    expect(url.searchParams.get("scope")?.split(",")).toContain("page_events")
  })

  test("matches trimmed complete app IDs rather than substrings", () => {
    vi.stubEnv(
      "MESSENGER_OAUTH_MESSAGING_ONLY_APP_IDS",
      " approved-app, another-app ",
    )
    const scopeFor = (clientId: string) =>
      new URL(
        generateAuthUrl({
          clientId,
          redirectUrl: "https://example.com/callback",
        }),
      ).searchParams
        .get("scope")
        ?.split(",")
    expect(scopeFor("approved-app")).not.toContain("email")
    expect(scopeFor("approved-ap")).toContain("email")
  })

  test("leaves default behavior unchanged when the allowlist is absent", () => {
    vi.stubEnv("MESSENGER_OAUTH_MESSAGING_ONLY_APP_IDS", undefined)
    const url = new URL(
      generateAuthUrl({
        clientId: "approved-app",
        redirectUrl: "https://example.com/callback",
      }),
    )
    expect(url.searchParams.get("scope")?.split(",")).toContain(
      "pages_manage_ads",
    )
  })
})
