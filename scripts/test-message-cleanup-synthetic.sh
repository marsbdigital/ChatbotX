#!/usr/bin/env bash
set -euo pipefail

# Creates only disposable localhost services; refuses to reuse existing names.
# No .env is loaded and no hosted service credentials are used.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
db_name=mbd-chatbotx-deletion-test-db
objects_name=mbd-chatbotx-deletion-test-objects
db_id=''
objects_id=''
output_dir="${1:-$(mktemp -d /tmp/mbd-deletion-proof.XXXXXX)}"
mkdir -p "$output_dir"
for name in "$db_name" "$objects_name"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing to reuse existing container: $name" >&2
    exit 1
  fi
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer required")'
cleanup() {
  if [ -n "$objects_id" ]; then docker rm -fv "$objects_id" >/dev/null; fi
  if [ -n "$db_id" ]; then docker rm -fv "$db_id" >/dev/null; fi
}
trap cleanup EXIT
db_id=$(docker run -d --name "$db_name" --label purpose=mbd-synthetic-deletion-test \
  -e POSTGRES_USER=synthetic -e POSTGRES_PASSWORD=synthetic-local-only \
  -e POSTGRES_DB=mbd_deletion_synthetic -p 127.0.0.1:55439:5432 \
  timescale/timescaledb-ha@sha256:aa6894727099544a69b240c1815718c8c76461b9cb90f00413aed934a66e7b4c)
objects_id=$(docker run -d --name "$objects_name" --label purpose=mbd-synthetic-deletion-test \
  -e RUSTFS_ACCESS_KEY=synthetic -e RUSTFS_SECRET_KEY=synthetic-local-only \
  -p 127.0.0.1:59039:9000 \
  rustfs/rustfs@sha256:fa19210ac4697c79d7ccca1ec9b0eb91aebacc6691991ffb14014bb3c67e6cc3 /data)
for attempt in {1..30}; do
  if docker exec "$db_id" pg_isready -U synthetic -d mbd_deletion_synthetic >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$db_id" pg_isready -U synthetic -d mbd_deletion_synthetic
(
  cd packages/filesystem
  node <<'JS'
const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3');
const client=new S3Client({endpoint:'http://127.0.0.1:59039',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic-local-only'}});
async function initialize() {
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await client.send(new CreateBucketCommand({Bucket:'mbd-synthetic'})); return; }
      catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
  } finally { client.destroy(); }
}
initialize().catch(error => { console.error(error); process.exitCode = 1; });
JS
)

export MBD_SYNTHETIC_DELETION_TEST=true
export DATABASE_URL=postgresql://synthetic:synthetic-local-only@127.0.0.1:55439/mbd_deletion_synthetic
export DATABASE_DEBUG=false
export S3_ENDPOINT=http://127.0.0.1:59039
export S3_BUCKET=mbd-synthetic
export S3_REGION=us-east-1
export S3_ACCESS_KEY_ID=synthetic
export S3_SECRET_ACCESS_KEY=synthetic-local-only
export REDIS_URL=redis://127.0.0.1:1
export LOG_LEVEL=silent
export ENABLE_MESSAGE_CLEANUP_SCHEDULER=false
export ENABLE_PERMANENT_CONTACT_ERASURE=true

pnpm --filter @chatbotx.io/business exec vitest run \
  __tests__/integration/message-cleanup-synthetic.test.ts --reporter=verbose 2>&1 | tee "$output_dir/tests.log"
docker exec "$db_id" psql -U synthetic -d mbd_deletion_synthetic -Atc \
  "SELECT version(); SELECT extversion FROM pg_extension WHERE extname='timescaledb';" > "$output_dir/database-version.txt"
node --version > "$output_dir/node-version.txt"
echo "Evidence saved to $output_dir; disposable containers and their volumes will now be removed."
