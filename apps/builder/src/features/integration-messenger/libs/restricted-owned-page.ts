import type { ConnectableFacebookPage } from "@chatbotx.io/integration-messenger/schema"

const ID_PATTERN = /^\d{1,30}$/
type ObjectValue = Record<string, unknown>
type LookupConfig = Record<
  "integrationId" | "workspaceId" | "pageId" | "appId" | "businessId",
  string
>
type LookupResult = {
  page?: ConnectableFacebookPage
  failure?: string
  httpStatus?: number
  code?: number
}
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" ? (value as ObjectValue) : {}

class LookupError extends Error {
  readonly httpStatus: number
  readonly code?: number

  constructor(httpStatus: number, code?: number) {
    super("Restricted Page lookup rejected")
    this.httpStatus = httpStatus
    this.code = code
  }
}

function configuration(): LookupConfig | undefined {
  try {
    const value = object(
      JSON.parse(process.env.MESSENGER_RECONNECT_OWNED_PAGE_LOOKUP ?? "null"),
    )
    const keys = [
      "integrationId",
      "workspaceId",
      "pageId",
      "appId",
      "businessId",
    ] as const
    if (
      !keys.every(
        (key) => typeof value[key] === "string" && ID_PATTERN.test(value[key]),
      )
    ) {
      return
    }
    return value as LookupConfig
  } catch {
    return
  }
}

/** Exact opt-in reconnect only. No business scan, client-page scan or Page import. */
export async function findRestrictedOwnedPage(props: {
  integrationId: string
  workspaceId: string
  pageId: string
  appId: string
  appSecret: string
  userToken: string
  version: string
}): Promise<LookupResult> {
  const config = configuration()
  if (
    !(
      config &&
      ["integrationId", "workspaceId", "pageId", "appId"].every(
        (key) =>
          config[key as keyof LookupConfig] ===
          props[key as keyof typeof props],
      )
    )
  ) {
    return {}
  }
  if (props.version !== "v25.0") {
    return { failure: "unsupportedVersion" }
  }

  async function get(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<ObjectValue> {
    const url = new URL(`https://graph.facebook.com/${props.version}/${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    const value = object(await response.json())
    if (!response.ok || value.error) {
      const code = object(value.error).code
      throw new LookupError(
        response.status,
        typeof code === "number" && Number.isSafeInteger(code)
          ? code
          : undefined,
      )
    }
    return value
  }

  try {
    let after = ""
    const seen = new Set<string>()
    for (let index = 0; index < 20; index++) {
      const result = await get(
        `${config.businessId}/owned_pages`,
        props.userToken,
        {
          fields: "id,name,access_token",
          limit: "100",
          ...(after ? { after } : {}),
        },
      )
      if (!Array.isArray(result.data)) {
        return { failure: "invalidResponse" }
      }
      const match = result.data
        .map(object)
        .find((page) => page.id === props.pageId)
      if (match) {
        if (
          typeof match.access_token !== "string" ||
          !match.access_token ||
          typeof match.name !== "string"
        ) {
          return { failure: "pageTokenMissing" }
        }
        const debug = await get(
          "debug_token",
          `${props.appId}|${props.appSecret}`,
          {
            input_token: match.access_token,
          },
        )
        const identity = object(debug.data)
        if (
          identity.is_valid !== true ||
          identity.type !== "PAGE" ||
          identity.app_id !== props.appId ||
          identity.profile_id !== props.pageId
        ) {
          return { failure: "pageIdentityMismatch" }
        }
        return {
          page: {
            id: props.pageId,
            name: match.name,
            access_token: match.access_token,
            isConnectable: true,
          },
        }
      }
      const paging = object(result.paging)
      if (!paging.next) {
        return { failure: "pageNotOwned" }
      }
      const cursor = object(paging.cursors).after
      if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
        return { failure: "invalidPagination" }
      }
      seen.add(cursor)
      after = cursor
    }
    return { failure: "paginationLimit" }
  } catch (error) {
    return error instanceof LookupError
      ? {
          failure: "graphRejected",
          httpStatus: error.httpStatus,
          code: error.code,
        }
      : { failure: "requestFailed" }
  }
}
