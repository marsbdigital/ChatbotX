import { messageCleanupService } from "@chatbotx.io/business"
import { getChildLogger } from "@chatbotx.io/logger"
import { distributedLock } from "@chatbotx.io/redis"

const log = getChildLogger("purge-message-cleanup")
const BATCH_LIMIT = 25

/** Bounded contact-message erasure pass. The scheduler itself is opt-in. */
export async function purgeMessageCleanup(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:purge-message-cleanup",
    timeoutInSeconds: 240,
    fn: async () => {
      const { processed, failed } = await messageCleanupService.processPending({
        limit: BATCH_LIMIT,
      })

      if (failed > 0) {
        log.warn({ processed, failed }, "Message cleanup pass had failures")
      } else if (processed > 0) {
        log.info({ processed }, "Message cleanup pass completed")
      }
    },
  })
}
