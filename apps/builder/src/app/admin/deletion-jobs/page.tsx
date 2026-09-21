import { isSuperAdmin, messageCleanupService } from "@chatbotx.io/business"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { retryCleanup } from "@/features/admin/actions/retry-cleanup"
import { enforcePasswordCurrent } from "@/lib/auth/require-password-current"
import { getCurrentUser } from "@/lib/auth/utils"

export default async function DeletionJobsPage() {
  const user = await getCurrentUser()
  if (!(user && isSuperAdmin(user))) {
    return notFound()
  }
  enforcePasswordCurrent(user)
  const t = await getTranslations("deletionJobs")
  const { counts, jobs } = await messageCleanupService.operatorStatus()
  const enabled = process.env.ENABLE_MESSAGE_CLEANUP_SCHEDULER === "true"
  return (
    <div className="space-y-5">
      <h1 className="font-bold text-xl">{t("title")}</h1>
      <p>{t(enabled ? "enabled" : "disabled")}</p>
      <p className="text-muted-foreground">{t("instructions")}</p>
      <dl className="flex flex-wrap gap-6">
        {["pending", "processing", "failed", "completed"].map((status) => (
          <div key={status}>
            <dt>{t(status)}</dt>
            <dd className="font-semibold text-xl">
              {counts.find((row) => row.status === status)?.count ?? 0}
            </dd>
          </div>
        ))}
      </dl>
      {jobs.length === 0 ? (
        <p>{t("noFailures")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "job",
                  "workspace",
                  "status",
                  "attempts",
                  "updated",
                  "action",
                ].map((key) => (
                  <th className="p-3" key={key}>
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr className="border-t" key={job.id}>
                  <td className="p-3 font-mono">{job.id}</td>
                  <td className="p-3">{job.workspaceId}</td>
                  <td className="p-3">{t(job.status)}</td>
                  <td className="p-3">{job.attempts}</td>
                  <td className="p-3">{job.updatedAt.toISOString()}</td>
                  <td className="p-3">
                    {job.attempts >= 10 ? (
                      <form action={retryCleanup}>
                        <input name="id" type="hidden" value={job.id} />
                        <button
                          className="rounded border px-3 py-2 disabled:opacity-50"
                          disabled={!enabled}
                          type="submit"
                        >
                          {t("retry")}
                        </button>
                      </form>
                    ) : (
                      t("automaticRetry")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-muted-foreground">{t("limit")}</p>
        </div>
      )}
    </div>
  )
}
