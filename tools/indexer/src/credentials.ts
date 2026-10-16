/**
 * CompanyIntel — server-side R2 credential resolution (the "fixed credentials" step).
 *
 * ONE place decides which R2 credentials a local tool uses, and it is only ever
 * loaded by non-deployed, server-side code:
 *
 *   tools/indexer/**      the indexer (MODE B source reads, --upload, publish)
 *   scripts/**            verify-raw, profile-raw, r2-doctor
 *
 * Nothing in `src/**` (the browser bundle) or `worker/**` (the deployed Worker)
 * imports this module: the Worker uses the native `COMPANY_DATA` binding and has
 * no S3 credentials at all. `tests/worker-r2-binding.test.ts` and
 * `tests/secrets-not-exposed.test.ts` enforce both halves of that rule.
 *
 * Resolution order — first complete set wins:
 *
 *   1. ENVIRONMENT (an explicit override, e.g. a different bucket or token):
 *        R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID
 *        R2_ENDPOINT_URL (optional, full S3 endpoint)
 *        R2_ACCESS_KEY_ID
 *        R2_SECRET_ACCESS_KEY
 *        R2_BUCKET_NAME (optional, defaults to company-intel-data)
 *        R2_REGION (optional, defaults to auto)
 *   2. PRIVATE LOCAL FILE, first one that exists:
 *        $COMPANYINTEL_R2_CREDENTIALS (explicit path, if set)
 *        <repo>/.r2-credentials.json          ← the file this project uses
 *        <repo>/.r2-credentials/r2.json
 *        ~/.config/companyintel/r2-credentials.json
 *      The repo file is listed in .gitignore, is never imported by the frontend
 *      or the Worker, and never reaches a build output directory.
 *   3. Otherwise: no credentials — tools fail early, loudly, and without values.
 *
 * Guarantees this module keeps (asserted by tests):
 *   - credential VALUES are never returned in status objects, thrown messages or
 *     log lines; only presence booleans, the (non-secret) account id, the endpoint
 *     host, the bucket and the region are reported;
 *   - the endpoint and the bucket name are validated before use, and an endpoint
 *     that disagrees with the account id is rejected instead of silently ignored;
 *   - nothing is read from Vite `VITE_*` variables or any other build-time
 *     variable: secrets cannot reach the browser bundle through this path.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** S3 credentials for one bucket, as every local R2 client needs them. */
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Full S3 endpoint. Defaults to `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** SigV4 scope region. R2 always signs with `auto`. */
  region?: string;
}

/** Shape of the private local credentials file (unknown keys are ignored). */
export interface R2CredentialFile {
  endpoint?: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region?: string;
  rawPrefix?: string;
}

export const DEFAULT_BUCKET = "company-intel-data";
export const DEFAULT_REGION = "auto";
export const DEFAULT_RAW_PREFIX = "raw/";
export const DEFAULT_CREDENTIAL_FILE_NAME = ".r2-credentials.json";

/** Repository root, resolved from this file so it never depends on the cwd. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const ACCOUNT_HOST_SUFFIX = ".r2.cloudflarestorage.com";
/** R2 bucket names: 3–63 chars, lowercase alphanumeric and hyphens. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Candidate private credential files, most specific first.
 *
 * `COMPANYINTEL_R2_CREDENTIALS` (or `R2_CREDENTIALS_FILE`) is authoritative when
 * set: that exact path is the only file consulted, which is what makes the
 * lookup testable and lets you keep the file outside the repository entirely
 * (for example on an encrypted volume).
 *
 * The list never includes a `.env` file: environment files are for build-time
 * variables and are the wrong place for a long-lived S3 secret (they get copied,
 * committed and pasted). A dedicated, git-ignored JSON file keeps the blast
 * radius at one path that this module is the only reader of.
 */
export function credentialFileCandidates(): string[] {
  const explicit = envValue("COMPANYINTEL_R2_CREDENTIALS", "R2_CREDENTIALS_FILE");
  if (explicit) return [resolve(explicit)];
  const candidates: string[] = [];
  candidates.push(join(REPO_ROOT, DEFAULT_CREDENTIAL_FILE_NAME));
  candidates.push(join(REPO_ROOT, ".r2-credentials", "r2.json"));
  const home = envValue("HOME", "USERPROFILE") ?? homedir();
  if (home) candidates.push(join(home, ".config", "companyintel", "r2-credentials.json"));
  return candidates;
}

interface LoadedFile {
  path: string;
  value: R2CredentialFile;
}

// `undefined` = not looked up yet, `null` = looked up and absent. Cached so a run
// reads the file once, and so tests can reset it with `resetCredentialCache()`.
let cachedFile: LoadedFile | null | undefined;

/** Clears the memoised credential file lookup (tests, and explicit re-reads). */
export function resetCredentialCache(): void {
  cachedFile = undefined;
}

/** The first candidate path that exists, whether or not it is readable JSON. */
export function credentialFilePath(): string | null {
  return readCredentialFile()?.path ?? null;
}

function readCredentialFile(): LoadedFile | null {
  if (cachedFile !== undefined) return cachedFile;
  cachedFile = null;
  for (const path of credentialFileCandidates()) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The path is reported; the contents never are.
      throw new Error(
        `The R2 credentials file ${path} is not valid JSON. Fix or delete it — its contents were not read.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`The R2 credentials file ${path} must contain a JSON object.`);
    }
    cachedFile = { path, value: parsed as R2CredentialFile };
    break;
  }
  return cachedFile;
}

/** POSIX file mode of the credential file (e.g. 0o600), or null when unknown. */
export function credentialFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Rejects an unusable bucket name instead of sending a request that cannot work. */
export function validatedBucket(bucket: string): string {
  const trimmed = String(bucket ?? "").trim();
  if (!BUCKET_PATTERN.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not a valid R2 bucket name (3–63 characters: lowercase letters, digits and hyphens).`,
    );
  }
  return trimmed;
}

/** Rejects a malformed region rather than signing a request that will fail. */
export function validatedRegion(region: string): string {
  const trimmed = String(region ?? "").trim() || DEFAULT_REGION;
  if (!REGION_PATTERN.test(trimmed)) throw new Error(`"${trimmed}" is not a valid R2 region (use "auto").`);
  return trimmed;
}

/**
 * Validates an S3 endpoint and returns it without the trailing slash.
 *
 * Only `https` is accepted, plus `http` for a loopback host (a local test stub).
 * A `*.r2.cloudflarestorage.com` host is the R2 S3 endpoint and its first label
 * is the account id, so an endpoint that contradicts `R2_ACCOUNT_ID` is refused
 * instead of silently overriding it.
 */
export function normalizedEndpoint(endpoint: string, accountId?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("R2_ENDPOINT_URL is not a valid URL. Expected https://<account-id>.r2.cloudflarestorage.com.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("R2_ENDPOINT_URL must use https:// (http:// is allowed only for a loopback test stub).");
  }
  const host = parsed.hostname;
  if (host.endsWith(ACCOUNT_HOST_SUFFIX)) {
    const fromEndpoint = host.slice(0, -ACCOUNT_HOST_SUFFIX.length);
    if (accountId && fromEndpoint && accountId !== fromEndpoint) {
      throw new Error(
        "R2_ENDPOINT_URL and R2_ACCOUNT_ID refer to different accounts. " +
          `The endpoint host belongs to ${fromEndpoint.slice(0, 6)}… while the account id starts with ${accountId.slice(0, 6)}…. ` +
          "Fix one of them; nothing was read.",
      );
    }
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** Account id implied by an R2 S3 endpoint, or null for any other host. */
export function accountIdFromEndpoint(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname;
    if (!host.endsWith(ACCOUNT_HOST_SUFFIX)) return null;
    return host.slice(0, -ACCOUNT_HOST_SUFFIX.length) || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export type CredentialSource = "env" | "file" | "none";

/** Everything the doctor/report needs, with no credential values in it. */
export interface CredentialStatus {
  source: CredentialSource;
  /** Private file that was read, or would be read, or null when none exists. */
  filePath: string | null;
  fileMode: number | null;
  accountId: string | null;
  endpoint: string | null;
  endpointHost: string | null;
  bucket: string;
  region: string;
  rawPrefix: string;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  /** Human-readable notes for the report; never contains a value. */
  notices: string[];
}

export interface ResolvedCredentials {
  credentials: R2Credentials | null;
  status: CredentialStatus;
}

interface BuildInput {
  accountId?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

function buildCredentials(input: BuildInput): R2Credentials {
  const endpoint = input.endpoint ? normalizedEndpoint(input.endpoint, input.accountId) : undefined;
  const accountId = input.accountId?.trim() || (endpoint ? accountIdFromEndpoint(endpoint) ?? "" : "");
  return {
    accountId,
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: input.secretAccessKey.trim(),
    bucket: validatedBucket(input.bucket),
    ...(endpoint ? { endpoint } : {}),
    region: validatedRegion(input.region ?? DEFAULT_REGION),
  };
}

function statusFor(
  source: CredentialSource,
  file: LoadedFile | null,
  bucket: string,
  region: string,
  rawPrefix: string,
  credentials: R2Credentials | null,
): CredentialStatus {
  const notices: string[] = [];
  if (source === "file" && file) {
    const mode = credentialFileMode(file.path);
    if (mode !== null && (mode & 0o077) !== 0) {
      notices.push(
        `The credentials file is readable by other users on this machine (mode 0${mode.toString(8)}). Tighten it with: chmod 600 ${file.path}`,
      );
    }
  }
  if (source === "env") notices.push("Credentials came from this process's environment; the private file was not used.");
  if (source === "none") {
    notices.push(
      "No credentials found. Create the private file (see docs/configuration.md) or export R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for this session.",
    );
  }
  return {
    source,
    filePath: file?.path ?? credentialFileCandidates()[0] ?? null,
    fileMode: file ? credentialFileMode(file.path) : null,
    accountId: credentials?.accountId ?? file?.value.accountId?.trim() ?? null,
    endpoint: credentials?.endpoint ?? (file?.value.endpoint ? file.value.endpoint.replace(/\/+$/, "") : null),
    endpointHost: credentials?.endpoint ? new URL(credentials.endpoint).host : null,
    bucket,
    region,
    rawPrefix,
    hasAccessKeyId: Boolean(credentials?.accessKeyId),
    hasSecretAccessKey: Boolean(credentials?.secretAccessKey),
    notices,
  };
}

/**
 * Resolve the credentials a local tool should use for `bucketOverride`.
 *
 * Returns `{ credentials: null, status }` — never a partially populated
 * credential object, and never an exception containing a value — when nothing is
 * configured, so callers can print the setup recipe and exit cleanly.
 */
export function resolveCredentials(bucketOverride?: string): ResolvedCredentials {
  const envBucket = envValue("R2_BUCKET_NAME");
  const file = readCredentialFile();
  const fileBucket = file?.value.bucket?.trim();
  const bucket = validatedBucket(bucketOverride?.trim() || envBucket || fileBucket || DEFAULT_BUCKET);
  const region = validatedRegion(envValue("R2_REGION") ?? file?.value.region ?? DEFAULT_REGION);
  const rawPrefix = (file?.value.rawPrefix ?? envValue("R2_RAW_PREFIX") ?? DEFAULT_RAW_PREFIX).trim();

  const envAccount = envValue("R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
  const envEndpoint = envValue("R2_ENDPOINT_URL", "R2_ENDPOINT");
  const envAccessKeyId = envValue("R2_ACCESS_KEY_ID");
  const envSecretAccessKey = envValue("R2_SECRET_ACCESS_KEY");

  // A half-set environment is a mistake worth stopping for: silently falling back
  // to the file would hide "I thought I was using a different token".
  if (envAccessKeyId || envSecretAccessKey || envAccount || envEndpoint) {
    if (!envAccessKeyId || !envSecretAccessKey) {
      throw new Error(
        "Incomplete R2 environment credentials: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set together " +
          "(unset both to use the private credentials file instead). No value was read or printed.",
      );
    }
    const credentials = buildCredentials({
      accountId: envAccount,
      endpoint: envEndpoint,
      accessKeyId: envAccessKeyId,
      secretAccessKey: envSecretAccessKey,
      bucket,
      region,
    });
    return { credentials, status: statusFor("env", file, credentials.bucket, credentials.region!, rawPrefix, credentials) };
  }

  if (file && file.value.accessKeyId && file.value.secretAccessKey) {
    const credentials = buildCredentials({
      accountId: file.value.accountId,
      endpoint: file.value.endpoint,
      accessKeyId: file.value.accessKeyId,
      secretAccessKey: file.value.secretAccessKey,
      bucket,
      region,
    });
    return { credentials, status: statusFor("file", file, credentials.bucket, credentials.region!, rawPrefix, credentials) };
  }

  return { credentials: null, status: statusFor(file ? "file" : "none", file, bucket, region, rawPrefix, null) };
}

/**
 * Convenience wrapper kept for the existing callers (indexer, scripts):
 * the credentials for a bucket, or null when none are configured.
 */
export function credentialsFromEnv(bucket = DEFAULT_BUCKET): R2Credentials | null {
  return resolveCredentials(bucket).credentials;
}

/** Endpoint used for a request set, whether or not it was configured explicitly. */
export function endpointFor(credentials: R2Credentials): string {
  return credentials.endpoint ?? `https://${credentials.accountId}${ACCOUNT_HOST_SUFFIX}`;
}

/* -------------------------------------------------------------------------- */
/* Command line safety                                                        */
/* -------------------------------------------------------------------------- */

const SECRET_FLAG = /^--(secret|secret-key|secret-access-key|access-key|access-key-id|r2-secret|credentials|token)(=|$)/i;
const SECRET_LIKE_VALUE = /^[A-Za-z0-9+/]{32,}={0,2}$/;

/**
 * Refuse to run when a credential looks like it was passed as a command-line
 * argument. Shell history, `ps` output and CI logs all keep those, which is why
 * this project reads the private file instead. Called by every R2 script.
 */
export function assertNoSecretsOnCommandLine(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (SECRET_FLAG.test(token)) {
      throw new Error(
        `${token.split("=")[0]} was passed on the command line. Credentials are never taken from arguments — ` +
          "they are read from the private credentials file (see docs/configuration.md). Remove it from your shell history.",
      );
    }
    if (index > 0 && /^--/.test(argv[index - 1]) && SECRET_LIKE_VALUE.test(token) && !token.includes("/")) {
      throw new Error(
        "A value on the command line looks like a credential. Credentials are never taken from arguments — " +
          "they are read from the private credentials file (see docs/configuration.md).",
      );
    }
  }
}
