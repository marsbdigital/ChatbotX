const ID_PATTERN = /^\d{1,30}$/
const TASK_PATTERN = /^[A-Z_]{1,64}$/
const SCOPE_PATTERN = /^[a-z_]{1,100}$/

type ObjectValue = Record<string, unknown>
type DiagnosticError = {
  httpStatus?: number
  code?: number
  subcode?: number
  failure?: string
}
type Result = { value?: ObjectValue; error?: DiagnosticError }

const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" ? (value as ObjectValue) : {}
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const id = (value: unknown): string | undefined =>
  typeof value === "string" && ID_PATTERN.test(value) ? value : undefined
const names = (value: unknown, pattern: RegExp): string[] =>
  items(value).filter(
    (item): item is string => typeof item === "string" && pattern.test(item),
  )
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined

export function isMessengerReconnectDiagnostic(integrationId: string): boolean {
  return (
    Boolean(id(integrationId)) &&
    (process.env.MESSENGER_RECONNECT_DIAGNOSTIC_INTEGRATION_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .includes(integrationId)
  )
}

/** In-memory, read-only dry run. Never return raw Graph objects, URLs, codes or tokens. */
export async function runMessengerReconnectDiagnostic(props: {
  credentialConfig: { clientId: string; clientSecret: string; version: string }
  code: string
  callbackUrl: string
  pageId: string
}): Promise<ObjectValue> {
  const version = props.credentialConfig.version
  const businessId = id(process.env.MESSENGER_RECONNECT_DIAGNOSTIC_BUSINESS_ID)
  if (version !== "v25.0" || !businessId || !id(props.pageId)) {
    return { failure: "invalidDiagnosticConfiguration" }
  }

  async function get(
    path: string,
    bearer: string | undefined,
    params: Record<string, string> = {},
  ): Promise<Result> {
    try {
      const url = new URL(`https://graph.facebook.com/${version}/${path}`)
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
      const response = await fetch(url, {
        method: "GET",
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      })
      const value = object(await response.json())
      if (!response.ok || value.error) {
        const error = object(value.error)
        return {
          error: {
            httpStatus: response.status,
            code: number(error.code),
            subcode: number(error.error_subcode),
          },
        }
      }
      return { value }
    } catch {
      return { error: { failure: "requestFailed" } }
    }
  }

  async function list(
    path: string,
    bearer: string,
    fields: string,
  ): Promise<{
    values: unknown[]
    complete: boolean
    error?: DiagnosticError
  }> {
    const values: unknown[] = []
    let after = ""
    for (let page = 0; page < 20; page++) {
      const result = await get(path, bearer, {
        fields,
        limit: "100",
        ...(after ? { after } : {}),
      })
      if (result.error) {
        return { values, complete: false, error: result.error }
      }
      values.push(...items(result.value?.data))
      const paging = object(result.value?.paging)
      if (!paging.next) {
        return { values, complete: true }
      }
      const cursor = object(paging.cursors).after
      if (typeof cursor !== "string" || !cursor || cursor === after) {
        return {
          values,
          complete: false,
          error: { failure: "invalidPagination" },
        }
      }
      // Never follow upstream URLs: they can carry tokens or point off-origin.
      after = cursor
    }
    return { values, complete: false, error: { failure: "paginationLimit" } }
  }

  const short = await get("oauth/access_token", undefined, {
    client_id: props.credentialConfig.clientId,
    client_secret: props.credentialConfig.clientSecret,
    redirect_uri: props.callbackUrl,
    code: props.code,
  })
  if (typeof short.value?.access_token !== "string") {
    return { version, failure: "codeExchangeFailed", error: short.error }
  }
  const long = await get("oauth/access_token", undefined, {
    grant_type: "fb_exchange_token",
    client_id: props.credentialConfig.clientId,
    client_secret: props.credentialConfig.clientSecret,
    fb_exchange_token: short.value.access_token,
  })
  const userToken =
    typeof long.value?.access_token === "string"
      ? long.value.access_token
      : short.value.access_token
  const debug = await get(
    "debug_token",
    `${props.credentialConfig.clientId}|${props.credentialConfig.clientSecret}`,
    { input_token: userToken },
  )
  const data = object(debug.value?.data)
  const permissions = await list(
    "me/permissions",
    userToken,
    "permission,status",
  )
  const pages = await list(
    "me/accounts",
    userToken,
    "id,name,access_token,category,tasks",
  )
  const businesses = await list("me/businesses", userToken, "id,name")
  const owned = await list(
    `${businessId}/owned_pages`,
    userToken,
    "id,name,access_token,category",
  )

  const safePages = (values: unknown[]) =>
    values
      .map(object)
      .map((page) => ({
        id: id(page.id),
        tasks: names(page.tasks, TASK_PATTERN),
        tokenPresent:
          typeof page.access_token === "string" && page.access_token.length > 0,
      }))
      .filter((page) => page.id)
  return {
    version,
    targetPageId: id(props.pageId),
    targetBusinessId: businessId,
    longLivedExchange: {
      succeeded: typeof long.value?.access_token === "string",
      error: long.error,
    },
    token: {
      appId: id(data.app_id),
      valid: data.is_valid === true,
      issuedAt: number(data.issued_at),
      scopes: names(data.scopes, SCOPE_PATTERN),
      targets: items(data.granular_scopes)
        .map(object)
        .map((scope) => ({
          scope: names([scope.scope], SCOPE_PATTERN)[0],
          ids: items(scope.target_ids).map(id).filter(Boolean),
        }))
        .filter((scope) => scope.scope),
      error: debug.error,
    },
    permissions: {
      values: permissions.values
        .map(object)
        .map((permission) => ({
          permission: names([permission.permission], SCOPE_PATTERN)[0],
          status: ["granted", "declined", "expired"].includes(
            String(permission.status),
          )
            ? permission.status
            : "unknown",
        }))
        .filter((permission) => permission.permission),
      complete: permissions.complete,
      error: permissions.error,
    },
    pages: {
      values: safePages(pages.values),
      complete: pages.complete,
      error: pages.error,
    },
    businesses: {
      ids: businesses.values
        .map(object)
        .map((business) => id(business.id))
        .filter(Boolean),
      complete: businesses.complete,
      error: businesses.error,
    },
    ownedPages: {
      values: safePages(owned.values),
      complete: owned.complete,
      error: owned.error,
    },
  }
}
