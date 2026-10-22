/**
 * Restore the production Worker's secrets from the operator's own private R2
 * credential file (read through the project's resolver, never printed) plus the
 * Access application values discoverable from the account.
 */
import { credentialsFromEnv } from "../tools/indexer/src/credentials.ts";

const email = process.env.CF_EMAIL;
const key = process.env.CF_KEY;
const account = process.env.CF_ACCOUNT;
if (!email || !key || !account) throw new Error("CF_EMAIL / CF_KEY / CF_ACCOUNT must be set");

// Bun auto-loads a local .env that may carry a partial R2 setting; clear it so the
// resolver uses the operator's private credential file, which is the complete one.
console.log(
  "env presence:",
  JSON.stringify(
    Object.fromEntries(
      ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID", "R2_ENDPOINT"].map((name) => [
        name,
        String(process.env[name] ?? "").length,
      ]),
    ),
  ),
);
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET", "CLOUDFLARE_ACCOUNT_ID", "R2_ENDPOINT_URL", "R2_BUCKET_NAME"]) {
  if (process.env.KEEP_ENV_CREDS !== "true") delete process.env[name];
}
// `resolveCredentials()` returns `{ credentials, status }` — the credential VALUES
// live on `.credentials`, and reading the wrapper directly silently produced empty
// secrets earlier in this run.
const resolved = credentialsFromEnv();
if (!resolved) throw new Error("no R2 credentials resolved");
const creds = resolved;
const endpoint = creds.endpoint ?? "";
const accountId = process.env.CF_ACCOUNT ?? creds.accountId ?? (endpoint.match(/https:\/\/([0-9a-f]{32})\./) ?? [])[1];
if (!accountId) throw new Error("could not determine the R2 account id");

console.log(
  "resolved lengths:",
  JSON.stringify({
    accountId: String(accountId).length,
    accessKeyId: String(creds.accessKeyId ?? "").length,
    secretAccessKey: String(creds.secretAccessKey ?? "").length,
  }),
);

const desired = {
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: creds.accessKeyId,
  R2_SECRET_ACCESS_KEY: creds.secretAccessKey,
  CF_ACCESS_TEAM_DOMAIN: "weathered-wind-e083.cloudflareaccess.com",
  CF_ACCESS_AUD: "c2d2acd9d80442dbee286ee671c3bec5d43b50eae9bb8f0f76c0ca7746b0a3d8",
  ALLOWED_EMAILS: "acharya.priyank7@gmail.com",
};

for (const [name, text] of Object.entries(desired)) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/companyintel/secrets`,
    {
      method: "PUT",
      headers: { "X-Auth-Email": email, "X-Auth-Key": key, "content-type": "application/json" },
      body: JSON.stringify({ name, text, type: "secret_text" }),
    },
  );
  const payload = await response.json();
  console.log(name, payload.success ? "ok" : `FAILED ${JSON.stringify(payload.errors)}`);
}
