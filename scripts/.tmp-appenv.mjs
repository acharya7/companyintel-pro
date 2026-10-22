/**
 * Put the R2 credentials into the container application's own environment.
 *
 * The Durable Object forwards R2_* from the Worker's secrets, but a container that
 * boots before those bindings resolve sees an incomplete set and every task fails with
 * "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set together". The application
 * configuration is the container's own base environment, so setting it there makes the
 * credentials independent of the forwarding path.
 */
import { resolveCredentials } from "../tools/indexer/src/credentials.ts";

for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET", "CLOUDFLARE_ACCOUNT_ID"]) {
  delete process.env[name];
}

const email = process.env.CF_EMAIL;
const key = process.env.CF_KEY;
const account = process.env.CF_ACCOUNT;
const appIds = (process.env.APP_IDS ?? "").split(",").filter(Boolean);
const creds = resolveCredentials();
const accountId = account ?? creds.accountId;

const env = {
  R2_ACCOUNT_ID: String(accountId),
  R2_ACCESS_KEY_ID: creds.accessKeyId,
  R2_SECRET_ACCESS_KEY: creds.secretAccessKey,
};

for (const appId of appIds) {
  const current = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${appId}`, {
    headers: { "X-Auth-Email": email, "X-Auth-Key": key },
  }).then((r) => r.json());
  const app = current.result;
  const body = {
    ...app,
    configuration: { ...app.configuration, env },
  };
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${appId}`,
    {
      method: "PUT",
      headers: { "X-Auth-Email": email, "X-Auth-Key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json();
  console.log(appId, response.status, payload.success ? "ok" : JSON.stringify(payload.errors));
}
