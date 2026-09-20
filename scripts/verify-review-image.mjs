// Run inside the built image with networking disabled. Never starts the app,
// connects to a database, or prints environment values.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const kind = process.argv[2]
assert.ok(kind === "builder" || kind === "worker")
assert.equal(process.arch, "x64")
assert.ok(Number(process.versions.node.split(".")[0]) >= 24)
assert.equal(process.env.BETTER_AUTH_SECRET, undefined)
const root =
  kind === "builder"
    ? "/app/apps/builder/.next/server"
    : "/app/apps/worker/dist"
const required = ["ENABLE_PERMANENT_CONTACT_ERASURE", "Message cleanup claim"]
if (kind === "worker") {
  required.push("ENABLE_MESSAGE_CLEANUP_SCHEDULER")
}
const found = new Set()
for (const file of readdirSync(root, { recursive: true })) {
  if (!(file.endsWith(".js") || file.endsWith(".mjs"))) {
    continue
  }
  const body = readFileSync(join(root, file), "utf8")
  for (const value of required) {
    if (body.includes(value)) {
      found.add(value)
    }
  }
}
assert.equal(found.size, required.length, "Missing compiled cleanup safeguards")
const result = {
  kind,
  node: process.version,
  architecture: process.arch,
  safeguards: [...found],
}
if (kind === "builder") {
  const require = createRequire("/app/migrate-runner/package.json")
  const { readMigrationFiles } = require("drizzle-orm/migrator")
  const migrations = readMigrationFiles({
    migrationsFolder: "/app/migrate-runner/drizzle",
  })
  const migrationName = "20260920231705_contact-inbox-cleanup-identity"
  const baseline = migrations
    .filter((m) => m.name !== migrationName)
    .sort((a, b) => a.name.localeCompare(b.name))
  const fingerprint = createHash("md5")
    .update(baseline.map((m) => `${m.name}:${m.hash}`).join("\n"))
    .digest("hex")
  assert.equal(baseline.length, 168)
  assert.equal(fingerprint, "753e8979b058da9be12c5bab53eace64")
  assert.equal(migrations.length, 169)
  assert.equal(
    migrations.find((m) => m.name === migrationName)?.hash,
    "52d4b86418ec0dcebe9f90183d48b4eb1805f01992ba4588d45290acf3f1d940",
  )
  Object.assign(result, {
    baselineMigrations: 168,
    baselineFingerprint: fingerprint,
    totalMigrations: 169,
    migrationName,
  })
}
console.log(JSON.stringify(result, null, 2))
