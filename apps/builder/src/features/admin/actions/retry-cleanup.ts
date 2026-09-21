"use server"

import { isSuperAdmin, messageCleanupService } from "@chatbotx.io/business"
import { revalidatePath } from "next/cache"
import { notFound } from "next/navigation"
import { z } from "zod"
import { enforcePasswordCurrent } from "@/lib/auth/require-password-current"
import { getCurrentUser } from "@/lib/auth/utils"

const cleanupId = z.string().regex(/^\d{1,20}$/)

export async function retryCleanup(form: FormData): Promise<void> {
  const user = await getCurrentUser()
  if (!(user && isSuperAdmin(user))) {
    return notFound()
  }
  enforcePasswordCurrent(user)
  await messageCleanupService.retryExhausted(cleanupId.parse(form.get("id")))
  revalidatePath("/admin/deletion-jobs")
}
