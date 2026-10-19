import z from "zod"

const subscriptionPageSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string() }).optional(),
    })
    .optional(),
})

/** Instagram must not replace existing Page/Messenger field choices on reconnect. */
export async function hasPageSubscriptionForApp(props: {
  endpoint: string
  clientId: string
  accessToken: string
  get: (
    endpoint: string,
    options: {
      headers: Record<string, string>
      searchParams: Record<string, string>
    },
  ) => Promise<unknown>
}): Promise<boolean> {
  const seenCursors = new Set<string>()
  let after = ""
  while (true) {
    const page = subscriptionPageSchema.parse(
      await props.get(props.endpoint, {
        headers: { Authorization: `Bearer ${props.accessToken}` },
        searchParams: {
          fields: "id",
          limit: "100",
          ...(after ? { after } : {}),
        },
      }),
    )
    if (page.data.some((app) => app.id === props.clientId)) {
      return true
    }
    if (!page.paging?.next) {
      return false
    }
    const cursor = page.paging.cursors?.after
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error("Invalid Page subscription pagination")
    }
    seenCursors.add(cursor)
    after = cursor
  }
}
