import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";
import { R2BlobStore } from "../tools/cloud/store.ts";

const credentials = credentialsFromEnv();
if (!credentials) throw new Error("no credentials");
const store = new R2BlobStore(new R2Client(credentials));
const version = process.argv[2] ?? "full-2026-10-22";
for (const key of [
  `cloud/jobs/${version}/swarm/plan.json`,
  `cloud/jobs/${version}/swarm/status.json`,
]) {
  const value = await store.getJson(key).catch((e) => ({ error: String(e) }));
  console.log("=== " + key + " ===");
  console.log(JSON.stringify(value).slice(0, 2500));
}
