import "../../../../vitest-config/src/setup-env"
import { uploader } from "@chatbotx.io/filesystem"
import { messageCleanupService } from "../../../src/message-cleanup/service"

if (
  process.env.MBD_SYNTHETIC_DELETION_TEST !== "true" ||
  process.env.DATABASE_URL !==
    "postgresql://synthetic:synthetic-local-only@127.0.0.1:55439/mbd_deletion_synthetic" ||
  process.env.S3_ENDPOINT !== "http://127.0.0.1:59039" ||
  process.env.S3_BUCKET !== "mbd-synthetic"
) {
  throw new Error(
    "Crash worker only runs against the disposable synthetic services",
  )
}

// Hold the real processor after its DB claim commits, before any object is
// erased. The parent kills this process; no finally/exception handler runs.
uploader.deleteObject = async () => {
  process.send?.({ type: "claimed" })
  await new Promise<never>(() => {
    /* The parent terminates this deliberately held worker. */
  })
  throw new Error("Unreachable synthetic worker continuation")
}

await messageCleanupService.processPending({ limit: 1 })
