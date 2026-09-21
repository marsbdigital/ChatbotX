import { messageCleanupService } from "@chatbotx.io/business"
import { getChildLogger } from "@chatbotx.io/logger"
import { distributedLock } from "@chatbotx.io/redis"

const log = getChildLogger("maintain-cleanup-receipts")

export async function maintainCleanupReceipts(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:maintain-cleanup-receipts",
    timeoutInSeconds: 240,
    fn: async () => {
      const result = await messageCleanupService.maintainReceipts()
      if (result.exhausted > 0) {
        log.error(
          result,
          "Contact deletion needs operator attention: retry limit reached",
        )
      } else if (result.minimized > 0 || result.expired > 0) {
        log.info(result, "Deletion receipt maintenance completed")
      }
    },
  })
}
