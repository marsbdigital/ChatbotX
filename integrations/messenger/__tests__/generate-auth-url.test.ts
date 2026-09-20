import { describe, expect, test } from "vitest"
import {
  generateAuthUrl,
  MESSENGER_MESSAGING_ONLY_SCOPES,
  MESSENGER_SCOPES,
} from "../src/apis/auth"

describe("generateAuthUrl", () => {
  test("asks Facebook to rerequest previously declined permissions", () => {
    const authUrl = generateAuthUrl({
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
      stateParams: { workspaceId: "workspace-id" },
    })

    expect(new URL(authUrl).searchParams.get("auth_type")).toBe("rerequest")
  })

  test("keeps the existing full permissions by default", () => {
    const authUrl = generateAuthUrl({
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
    })

    expect(new URL(authUrl).searchParams.get("scope")).toBe(
      MESSENGER_SCOPES.join(","),
    )
  })

  test("requests only messaging permissions in messaging-only mode", () => {
    const authUrl = generateAuthUrl({
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
      scopeMode: "messaging-only",
    })

    expect(new URL(authUrl).searchParams.get("scope")).toBe(
      MESSENGER_MESSAGING_ONLY_SCOPES.join(","),
    )
  })
})
