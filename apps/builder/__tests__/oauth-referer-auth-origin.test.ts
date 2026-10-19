// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findActiveByDomain: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  customDomainService: {
    findActiveByDomain: mocks.findActiveByDomain,
  },
}))
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_URL: "https://operator.example.test",
    NEXT_PUBLIC_BUILDER_URL: "https://public.example.test",
  },
}))
vi.mock("@/lib/oauth-broker", () => ({
  getBrokerOrigin: () => "https://broker.example.test",
}))

import {
  FALLBACK_REDIRECT,
  isAllowedOrigin,
  resolveRelayTarget,
  sanitizeReferer,
} from "../src/lib/oauth-referer"

beforeEach(() => {
  mocks.findActiveByDomain.mockResolvedValue(undefined)
})

describe("configured authentication origin", () => {
  it.each([
    "https://operator.example.test",
    "https://operator.example.test:443/settings",
    "https://public.example.test",
    "https://broker.example.test",
  ])("accepts the exact configured origin: %s", async (url) => {
    expect(await isAllowedOrigin(new URL(url))).toBe(true)
    expect(mocks.findActiveByDomain).not.toHaveBeenCalled()
  })

  it.each([
    "http://operator.example.test",
    "https://operator.example.test:444",
    "https://operator.example.test.attacker.test",
    "https://sub.operator.example.test",
    "https://operator-example.test",
    "https://operator.example.test@attacker.test",
    "https://attacker.test",
  ])("rejects an untrusted origin: %s", async (url) => {
    expect(await isAllowedOrigin(new URL(url))).toBe(false)
    expect(await sanitizeReferer(url)).toBe(FALLBACK_REDIRECT)
  })

  it("preserves active custom-domain support", async () => {
    mocks.findActiveByDomain.mockResolvedValue({
      domain: "tenant.example.test",
    })
    expect(await isAllowedOrigin(new URL("https://tenant.example.test"))).toBe(
      true,
    )
    expect(mocks.findActiveByDomain).toHaveBeenCalledWith("tenant.example.test")
  })

  it("relays the callback unchanged to the private authentication origin", async () => {
    const callback = new URL(
      "https://public.example.test/integrations/messenger/callback?code=synthetic-code&state=synthetic-state",
    )
    const referer = "https://operator.example.test/space/synthetic/settings"
    expect(await resolveRelayTarget(callback, referer)).toBe(
      "https://operator.example.test/integrations/messenger/callback?code=synthetic-code&state=synthetic-state",
    )
    expect(await sanitizeReferer(referer)).toBe(referer)
  })

  it("stops relaying once the callback reaches its originating host", async () => {
    expect(
      await resolveRelayTarget(
        new URL(
          "https://operator.example.test/integrations/messenger/callback",
        ),
        "https://operator.example.test/settings",
      ),
    ).toBeNull()
  })

  it("does not relay to an arbitrary or malformed referer", async () => {
    const callback = new URL(
      "https://public.example.test/integrations/messenger/callback",
    )
    expect(
      await resolveRelayTarget(callback, "https://attacker.test"),
    ).toBeNull()
    expect(await resolveRelayTarget(callback, "invalid URL")).toBeNull()
    expect(await sanitizeReferer("invalid URL")).toBe(FALLBACK_REDIRECT)
  })
})
