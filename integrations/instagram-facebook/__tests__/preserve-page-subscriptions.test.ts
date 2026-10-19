import { HttpResponse, http, server } from "@chatbotx.io/vitest-config/msw"
import { describe, expect, test } from "vitest"
import {
  INSTAGRAM_SUBSCRIBE_FIELDS,
  subscribePageToInstagramWebhook,
} from "../src/apis/page"

const ENDPOINT = "https://graph.facebook.com/v25.0/page-1/subscribed_apps"
const props = {
  clientId: "instagram-app",
  pageId: "page-1",
  accessToken: "synthetic-page-token",
  version: "v25.0",
}

function trackWrites() {
  const writes: unknown[] = []
  server.use(
    http.post(ENDPOINT, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer synthetic-page-token",
      )
      writes.push(await request.json())
      return HttpResponse.json({ success: true })
    }),
  )
  return writes
}

describe("Instagram Facebook preserves existing app/Page subscriptions", () => {
  test.each([
    ["split-app feed-only setup", ["feed"]],
    ["ordinary same-app Messenger setup", INSTAGRAM_SUBSCRIBE_FIELDS],
    [
      "extra existing lead and custom fields",
      ["feed", "leadgen", "future_field"],
    ],
    ["an existing empty field selection", []],
  ])("does not write for %s", async (_, fields) => {
    const writes = trackWrites()
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-page-token",
        )
        expect(new URL(request.url).searchParams.get("fields")).toBe("id")
        return HttpResponse.json({
          data: [
            { id: "approved-messenger-app", subscribed_fields: ["messages"] },
            { id: props.clientId, subscribed_fields: fields },
          ],
        })
      }),
    )
    await subscribePageToInstagramWebhook(props)
    expect(writes).toEqual([])
  })

  test("keeps existing defaults for a new app/Page pair, ignoring other apps", async () => {
    const writes = trackWrites()
    server.use(
      http.get(ENDPOINT, () =>
        HttpResponse.json({ data: [{ id: "another-app" }] }),
      ),
    )
    await subscribePageToInstagramWebhook(props)
    expect(writes).toEqual([
      { subscribed_fields: INSTAGRAM_SUBSCRIBE_FIELDS.join(",") },
    ])
  })

  test("finds its own app on later pages without following provider URLs", async () => {
    const writes = trackWrites()
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        if (new URL(request.url).searchParams.get("after") === "cursor-1") {
          return HttpResponse.json({ data: [{ id: props.clientId }] })
        }
        return HttpResponse.json({
          data: [{ id: "other-app" }],
          paging: {
            next: "https://untrusted.example/not-followed",
            cursors: { after: "cursor-1" },
          },
        })
      }),
    )
    await subscribePageToInstagramWebhook(props)
    expect(writes).toEqual([])
  })

  test("subscribes only after all pages confirm this app is absent", async () => {
    const writes = trackWrites()
    server.use(
      http.get(ENDPOINT, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.has("after")
            ? { data: [] }
            : {
                data: [{ id: "other-app" }],
                paging: { next: "next", cursors: { after: "cursor-1" } },
              },
        ),
      ),
    )
    await subscribePageToInstagramWebhook(props)
    expect(writes).toHaveLength(1)
  })

  test.each([
    ["missing cursor", { next: "next" }],
    ["repeated cursor", { next: "next", cursors: { after: "same" } }],
  ])("fails without writing on %s pagination", async (_, paging) => {
    const writes = trackWrites()
    server.use(
      http.get(ENDPOINT, () => HttpResponse.json({ data: [], paging })),
    )
    await expect(subscribePageToInstagramWebhook(props)).rejects.toThrow()
    expect(writes).toEqual([])
  })

  test.each([
    [
      "HTTP error",
      () => HttpResponse.json({ error: { code: 190 } }, { status: 400 }),
    ],
    ["malformed response", () => HttpResponse.json({ unexpected: [] })],
  ])("fails without writing on %s", async (_, response) => {
    const writes = trackWrites()
    server.use(http.get(ENDPOINT, response))
    await expect(subscribePageToInstagramWebhook(props)).rejects.toThrow()
    expect(writes).toEqual([])
  })

  test("reports a failed new subscription instead of success", async () => {
    server.use(
      http.get(ENDPOINT, () => HttpResponse.json({ data: [] })),
      http.post(ENDPOINT, () => HttpResponse.json({ success: false })),
    )
    await expect(subscribePageToInstagramWebhook(props)).rejects.toThrow()
  })
})
