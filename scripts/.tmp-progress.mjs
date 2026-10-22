import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";
import { R2BlobStore } from "../tools/cloud/store.ts";

const credentials = credentialsFromEnv();
if (!credentials) throw new Error("no credentials");
const store = new R2BlobStore(new R2Client(credentials));
const version = "full-2026-10-22";
const root = `cloud/jobs/${version}`;

async function snapshot() {
  const partitions = await store.list(`${root}/partitions/`);
  const parts = await store.list(`${root}/pass2/parts/exact/0000/`);
  const shards = await store.list(`${root}/pass2/shards/`);
  return {
    partitions: partitions.length,
    partObjects: parts.length,
    partBytes: parts.reduce((sum, object) => sum + object.size, 0),
    shardObjects: shards.length,
  };
}

const first = await snapshot();
console.log("first", JSON.stringify(first));
await new Promise((resolve) => setTimeout(resolve, 45000));
const second = await snapshot();
console.log("second", JSON.stringify(second));
console.log("delta parts", second.partObjects - first.partObjects, "bytes", second.partBytes - first.partBytes);
