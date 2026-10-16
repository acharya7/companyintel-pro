#!/usr/bin/env node
/**
 * CompanyIntel — R2 credential doctor (read-only).
 *
 *   bun run r2:doctor
 *   bun run r2:doctor --json            # one share-safe JSON report
 *   bun run r2:doctor --max 10 --prefix raw/
 *
 * Answers the three questions that must be settled before any real run:
 *
 *   1. which credentials will the server-side tools use (private file, or an
 *      explicit environment override)? — reported WITHOUT printing any value;
 *   2. are the endpoint and the bucket name valid, and does the endpoint agree
 *      with the account id?
 *   3. do the access key id and the secret access key actually form a working
 *      pair? — proved by ONE bounded, signed `ListObjectsV2` request, not by
 *      assuming that "the credentials are present" means "the credentials work".
 *
 * Read-only by construction: the only request it can make is a listing. It never
 * writes, uploads, deletes, publishes or deploys, and it never takes a credential
 * from the command line (see `assertNoSecretsOnCommandLine`).
 *
 * Exit codes: 0 = credentials verified; 1 = credentials present but rejected (or
 * the bucket/endpoint is wrong); 2 = no credentials configured at all.
 */

import { R2Client } from "../tools/indexer/src/r2.ts";
import {
  DEFAULT_RAW_PREFIX,
  REPO_ROOT,
  assertNoSecretsOnCommandLine,
  credentialFileCandidates,
  resolveCredentials,
} from "../tools/indexer/src/credentials.ts";
import { classifyProbe, formatCredentialReport, redact, s3ErrorCode, s3ErrorMessage } from "./lib/credential-report.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

try {
  assertNoSecretsOnCommandLine(argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const asJson = Boolean(flag("json"));
const max = positiveInt(flag("max", 5), 5);

function printSetupRecipe(repoRoot = REPO_ROOT, extra = []) {
  const path = credentialFileCandidates()[0] ?? `${repoRoot}/.r2-credentials.json`;
  console.error(
    [
      "No R2 credentials are configured for the server-side tools.",
      "",
      `Create the private, git-ignored file ${path}:`,
      "",
      "  {",
      '    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",',
      '    "accountId": "<account id>",',
      '    "accessKeyId": "<R2 access key id>",',
      '    "secretAccessKey": "<R2 secret access key>",',
      '    "bucket": "company-intel-data",',
      '    "region": "auto"',
      "  }",
      "",
      `Then tighten its permissions:  chmod 600 ${path}`,
      "",
      "Every server-side tool picks that file up automatically (indexer, verify:r2,",
      "profile:raw, r2:doctor). It is excluded by .gitignore, is never imported by the",
      "browser bundle or by the deployed Worker, and never appears in a build output.",
      "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in the environment still override it for",
      "a single session.",
      ...extra,
    ].join("\n"),
  );
}

let resolved;
try {
  resolved = resolveCredentials(typeof flag("bucket") === "string" ? String(flag("bucket")) : undefined);
} catch (error) {
  // A malformed environment/bucket is a configuration error, not a network one.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { credentials, status } = resolved;
const notices = [...status.notices];

if (!credentials) {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          credentials: status,
          probe: { attempted: false },
          verdict: { code: "not-configured", summary: "No R2 credentials are configured." },
          notices,
        },
        null,
        2,
      ),
    );
  } else {
    printSetupRecipe();
  }
  process.exit(2);
}

const prefix = String(flag("prefix", status.rawPrefix || DEFAULT_RAW_PREFIX));
const client = new R2Client(credentials);
const started = Date.now();
const probe = {
  attempted: true,
  ok: false,
  httpStatus: null,
  errorCode: null,
  errorMessage: null,
  max,
  objects: [],
  objectCount: 0,
  truncated: false,
  elapsedMs: 0,
};

// The values that must never survive into the report. Only ever used for redaction.
// The account id is deliberately NOT in this list: it is not a secret (it is the
// first label of the endpoint URL) and it is printed on purpose.
const secretValues = [credentials.accessKeyId, credentials.secretAccessKey];

try {
  // max + 1 so "there are more" is observed rather than assumed.
  const objects = await client.list(prefix, max + 1);
  probe.ok = true;
  probe.httpStatus = 200;
  probe.truncated = objects.length > max;
  probe.objects = objects.slice(0, max).map((object) => ({
    key: object.key,
    sizeBytes: typeof object.size === "number" ? object.size : null,
    lastModified: object.lastModified ?? null,
  }));
  probe.objectCount = objects.length;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = Number(/HTTP (\d{3})/.exec(message)?.[1] ?? NaN);
  const body = message.slice(message.indexOf("HTTP") + 4);
  probe.httpStatus = Number.isFinite(httpStatus) ? httpStatus : null;
  probe.errorCode = s3ErrorCode(body);
  probe.errorMessage = s3ErrorMessage(body) ?? message;
  if (probe.httpStatus === null && !/failed to fetch|fetch failed|ENOTFOUND|ECONN|network/i.test(message)) {
    probe.errorCode = probe.errorCode ?? null;
  }
} finally {
  probe.elapsedMs = Date.now() - started;
}

const verdict = classifyProbe({ httpStatus: probe.httpStatus, code: probe.errorCode, threw: probe.httpStatus === null });

if (probe.ok && !probe.objects.length) {
  notices.push(
    `The listing succeeded but ${prefix} returned no objects. If the CSV uploads are expected there, check the prefix spelling.`,
  );
}
if (verdict.code !== "valid" && verdict.code !== "network-error") {
  notices.push(
    "Nothing was modified. Fix the cause above, then re-run `bun run r2:doctor`. " +
      "The same credentials are used by `bun run verify:r2` and by the indexer's MODE B reads.",
  );
}

const report = {
  checkedAt: new Date().toISOString(),
  credentials: status,
  probe,
  verdict,
  notices,
};

if (asJson) {
  // The endpoint's own error text is redacted before it is emitted, in JSON too.
  const shareSafe = {
    ...report,
    credentials: { ...status },
    probe: {
      ...probe,
      errorMessage: probe.errorMessage ? redact(probe.errorMessage, secretValues) : null,
    },
  };
  console.log(JSON.stringify(shareSafe, null, 2));
} else {
  const rendered = formatCredentialReport({ ...report, secretValues });
  // Belt and braces: never print a report that still contains a live secret.
  for (const value of secretValues) {
    if (value && rendered.includes(value)) {
      console.error("Refusing to print the report: a credential value survived redaction.");
      process.exit(1);
    }
  }
  console.log(rendered);
}

process.exitCode = probe.ok ? 0 : 1;
