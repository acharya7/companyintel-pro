/**
 * Pure formatter for `scripts/r2-doctor.mjs`.
 *
 * Kept separate from the script so the report — including the redaction rules —
 * can be unit-tested without a network, a bucket or a credential: the whole point
 * of this report is that a credential value cannot appear in it.
 */

/** Long random-looking tokens (key ids, secrets, signatures) inside S3 messages. */
const TOKEN_LIKE = /[A-Za-z0-9+/]{20,}={0,3}/g;

/**
 * Remove anything that could be a credential value from a string that will be
 * printed. Two passes: exact known values first, then anything token-shaped, so an
 * error string that echoes a key id or a signature cannot leak one.
 */
export function redact(text, secretValues = []) {
  let output = String(text ?? "");
  for (const value of secretValues) {
    if (typeof value === "string" && value.length >= 8) {
      output = output.split(value).join("[redacted]");
    }
  }
  return output.replace(TOKEN_LIKE, "[redacted]");
}

/** S3 error code out of an XML error body, or null. */
export function s3ErrorCode(body) {
  const match = /<Code>([\s\S]*?)<\/Code>/.exec(String(body ?? ""));
  return match ? match[1].trim() : null;
}

/** S3 error message out of an XML error body, or null. */
export function s3ErrorMessage(body) {
  const match = /<Message>([\s\S]*?)<\/Message>/.exec(String(body ?? ""));
  return match ? match[1].trim() : null;
}

/**
 * Turn an HTTP status + S3 error body into a verdict a person can act on.
 *
 * The distinction that matters: "the key pair is wrong" (fix credentials) versus
 * "the credentials are fine but not allowed to read this" (fix the token scope)
 * versus "the bucket does not exist under this account" (fix the bucket name) —
 * and they are all different from the stub-host path used in tests.
 */
export function classifyProbe({ httpStatus, code, threw = false }) {
  if (threw) {
    return { code: "network-error", summary: "The endpoint could not be reached from this machine." };
  }
  if (httpStatus === 200) {
    return { code: "valid", summary: "The access key pair signed a real request that the endpoint accepted." };
  }
  switch (code) {
    case "SignatureDoesNotMatch":
      return {
        code: "invalid-credentials",
        summary: "The secret access key does not match the access key id (signature rejected).",
      };
    case "InvalidAccessKeyId":
      return { code: "invalid-credentials", summary: "The access key id is unknown to this account." };
    case "AccessDenied":
      return {
        code: "access-denied",
        summary: "The key pair is valid but is not allowed to list or read this bucket.",
      };
    case "NoSuchBucket":
      return { code: "missing-bucket", summary: "The bucket name does not exist in this account." };
    case "InvalidArgument":
    case "AuthorizationHeaderMalformed":
      return { code: "bad-request", summary: "The endpoint rejected the request shape (check R2_ENDPOINT_URL)." };
    default:
      if (httpStatus === 403) return { code: "access-denied", summary: "The endpoint refused this request (HTTP 403)." };
      if (httpStatus === 404) return { code: "missing-bucket", summary: "The endpoint reported not-found (HTTP 404)." };
      if (httpStatus >= 500) return { code: "service-error", summary: `The endpoint returned a server error (HTTP ${httpStatus}).` };
      return { code: "unknown", summary: `The endpoint returned HTTP ${httpStatus}.` };
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function modeString(mode) {
  return mode === null || mode === undefined ? "unknown" : `0${mode.toString(8).padStart(3, "0")}`;
}

/**
 * Render the doctor report.
 *
 * `report.secretValues` is used only for redaction and is never printed.
 */
export function formatCredentialReport(report) {
  const { credentials, probe, verdict, notices = [], secretValues = [] } = report;
  const lines = [];
  const say = (line = "") => lines.push(line);
  const safe = (text) => redact(text, secretValues);

  say(`CompanyIntel R2 credentials — doctor`);
  say(`checked at ${report.checkedAt}   read-only: nothing is written, uploaded or deleted`);
  say("");
  say("Credentials");
  const source =
    credentials.source === "env"
      ? "process environment (explicit override)"
      : credentials.source === "file"
        ? "private local file"
        : "not configured";
  say(`  source            ${source}`);
  if (credentials.filePath) {
    say(`  file              ${credentials.filePath}${credentials.fileMode !== null ? ` (mode ${modeString(credentials.fileMode)})` : ""}`);
  }
  say(`  endpoint          ${credentials.endpointHost ?? "(derived from the account id)"}`);
  say(`  account id        ${credentials.accountId ?? "unknown"}`);
  say(`  bucket            ${credentials.bucket}`);
  say(`  region            ${credentials.region}     raw prefix  ${credentials.rawPrefix}`);
  say(`  access key id     ${credentials.hasAccessKeyId ? "present (value never printed)" : "MISSING"}`);
  say(`  secret access key ${credentials.hasSecretAccessKey ? "present (value never printed)" : "MISSING"}`);
  say("");
  say("Probe (read-only ListObjectsV2 on the raw prefix)");
  if (!probe.attempted) {
    say("  skipped — no credentials to test");
  } else if (probe.ok) {
    say(`  ok    HTTP ${probe.httpStatus} in ${probe.elapsedMs} ms — access key id + secret access key are a matching pair`);
    say(`  objects under ${credentials.rawPrefix} (showing up to ${probe.max}): ${probe.objectCount} returned${probe.truncated ? ", more exist" : ""}`);
    for (const object of probe.objects) {
      say(`    ${formatBytes(object.sizeBytes).padStart(10)}  ${object.key}${object.lastModified ? `   ${object.lastModified}` : ""}`);
    }
    if (!probe.objects.length) say("    (none — the prefix may be empty or spelled differently)");
  } else {
    say(`  FAILED HTTP ${probe.httpStatus ?? "n/a"}${probe.errorCode ? ` ${probe.errorCode}` : ""} in ${probe.elapsedMs} ms`);
    if (probe.errorMessage) say(`  ${safe(probe.errorMessage)}`);
  }
  say("");
  for (const notice of notices) say(`  note: ${safe(notice)}`);
  if (notices.length) say("");
  say(`VERDICT ${verdict.summary}`);
  return lines.join("\n");
}
