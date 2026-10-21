# Configuration

Everything the app needs is configuration or an environment variable. No secret is ever
hardcoded, and no secret belongs in this document, in `wrangler.toml`, or in chat.

## 1. Frontend API mode

The browser talks to the deployed Worker by default. The bundled **synthetic sample
dataset** exists only for an explicit preview, never as a silent fallback:

| Variable | Value | Effect |
| --- | --- | --- |
| `VITE_API_MODE` | *(unset)* | All data comes from the Cloudflare Worker API on the same origin (`/api/...`). This is production behaviour and the default. |
| `VITE_API_MODE` | `worker` | Same as unset; kept for explicit configuration. |
| `VITE_API_MODE` | `local` | Synthetic sample data only, for `vite dev`/tests. A production build (`PROD`) ignores it and always uses the Worker API, so a stray local `.env.local` cannot put synthetic rows beside real R2 coverage. |
| `VITE_API_BASE_URL` | e.g. `https://companyintel.example.workers.dev` | Origin of the Worker API. Only needed when the frontend is served from a different origin. |

Cloudflare Workers Builds sets none of these, so a deployed build uses the Worker API. The
UI derives its status from `/api/dataset/status` and `/api/realdata/coverage`: an activated
version is labelled **REAL DATA — PARTIAL COVERAGE** (or COMPLETE COVERAGE), while **Demo
data** can only appear when the sample adapter itself reports `dataOrigin: "sample"`. A
failed status request is shown as an error with a retry — it never switches to demo mode.
Set these in your host's environment/Keys panel; the repository's `.env` files are managed
outside the code.

## 2. Worker configuration (`wrangler.toml`)

```toml
name = "companyintel"
main = "worker/src/index.ts"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"          # built frontend
binding = "ASSETS"
not_found_handling = "single-page-application"

[[r2_buckets]]
binding = "COMPANY_DATA"      # the binding name the Worker code uses
bucket_name = "company-intel-data"

[vars]
ENVIRONMENT = "production"
APP_VERSION = "0.1.0"
MAX_SEARCHES_PER_MINUTE = "180"
```

Keep the bucket **private**: no public bucket access, no `r2.dev` domain, no S3 credentials
inside the Worker. The Worker only ever uses the `COMPANY_DATA` binding.

## 3. Worker secrets

Set each of these once, with `wrangler secret put <NAME>` (values are typed into your own
terminal, never into chat and never into a file in this repository):

| Secret | Meaning | Where to find it |
| --- | --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Access team domain, e.g. `myteam.cloudflareaccess.com` | Cloudflare dashboard → Zero Trust → Settings → Custom Pages / team domain |
| `CF_ACCESS_AUD` | Audience (AUD) tag of the Access application protecting `companyintel` | Zero Trust → Access → Applications → your app → Overview |
| `ALLOWED_EMAILS` | Comma-separated allowlist, normally just your own address | your own email |
| `DEV_ALLOW_UNAUTHENTICATED` | `"true"` only for local `wrangler dev`. Ignored — and refused — when `ENVIRONMENT=production` | local only |

Optional vars: `ENVIRONMENT`, `APP_VERSION`, `MAX_SEARCHES_PER_MINUTE`.

## 4. Indexer configuration (`tools/indexer/indexer.config.json`)

```jsonc
{
  "datasetVersion": "v1",
  "sources": [
    // MODE B: read straight from R2 (bounded ranged reads; credentials come from
    // the private file in §5 — no export commands needed)
    // These are the REAL keys in the bucket, in the order this config uses them:
    //   csv1 = organizations (10,223,471,749 bytes, 51 columns)
    //   csv2 = people       (54,038,527,871 bytes, 39 columns)
    // Both are TAB separated, UTF-8 without BOM.
    { "id": "csv1", "path": "r2://company-intel-data/raw/file1.csv", "encoding": "utf-8", "delimiter": "\t" },
    { "id": "csv2", "path": "r2://company-intel-data/raw/file2.csv", "encoding": "utf-8", "delimiter": "\t" }
    // MODE A instead: a local path, e.g. "D:/company-intel/raw/file1.csv"
  ],
  "workDir": ".indexer-work",          // disk-backed spool/checkpoint area
  "outputDir": ".indexer-output",       // generated objects, one file per R2 object
  "rawCacheDir": ".indexer-raw-cache",  // MODE B only: local cache of the R2 objects (null = no cache)
  "partitions": 256,
  "shards": { "exact": 512, "prefix": 256, "token": 256, "trigram": 512, "ids": 256 },
  "upload": { "enabled": false, "bucket": "company-intel-data" }
}
```

- **Paths**: either a local CSV file (`D:/data/part1.csv`, forward slashes on Windows) or an R2
  object (`r2://company-intel-data/raw/<key>.csv`). Copy the exact keys from
  `bun run verify:r2:remote`; `profile` warns about a missing local file instead of guessing, and a
  wrong object key fails with HTTP 404 rather than silently indexing nothing.
- **`rawCacheDir`** (Mode B): where each R2 object is cached once, so a re-run resumes from disk.
  `null` streams without caching. Never commit it — see `.gitignore`.
- **Mode B credentials**: resolved automatically from the private file in §5 when any source is an
  `r2://` URL; Wrangler's login cannot be handed to the indexer. Object Read is enough to index,
  Read & Write only for `--upload`/`publish`. Details and the least-privilege steps:
  `docs/indexing.md`.
- **`columns`** (optional, per source): override any header→canonical-field mapping that the
  profiler got wrong, e.g. `"columns": { "companyname": "Organization", "email": "Email 1" }`.
- **`upload.bucket`** must stay `company-intel-data` unless you deliberately create another
  bucket (not necessary).
- Object sizes/partition counts inside a version are recorded in `directory.json`, so the
  Worker derives the same keys without configuration.
- R2 credentials for Mode B reads and for upload/publish are never written to this file: they are
  read from the private file in §5.

## 5. R2 credentials for the indexer and verification scripts (local machine only)

Used by Mode B (`r2://`) sources, `run --upload`, `publish`, `scripts/verify-raw.mjs`,
`scripts/r2-doctor.mjs` and `scripts/r2-schema.mjs`. **Not** used by the read-only probe or the
deployed Worker, which use the native `COMPANY_DATA` binding:

```bash
bun run verify:r2:remote          # no keys at all — your Wrangler login + the R2 binding
```

The fixed credentials live in ONE private, git-ignored JSON file that every server-side tool
picks up on its own — no exports, no per-run environment setup:

```jsonc
// .r2-credentials.json   (repository root; mode 600; listed in .gitignore)
{
  "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "accountId": "<account id>",
  "accessKeyId": "<R2 access key id>",
  "secretAccessKey": "<R2 secret access key>",
  "bucket": "company-intel-data",
  "region": "auto",
  "rawPrefix": "raw/"
}
```

```bash
chmod 600 .r2-credentials.json     # keep it unreadable by other users
bun run r2:doctor                  # confirms the file, the endpoint and a signed request
```

Resolution order (`tools/indexer/src/credentials.ts`, the single reader):

1. **environment override** — `R2_ACCOUNT_ID`/`CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` (plus optional `R2_ENDPOINT_URL`, `R2_BUCKET_NAME`, `R2_REGION`,
   `R2_RAW_PREFIX`) for a one-off session with a different token or bucket;
2. **private file** — `$COMPANYINTEL_R2_CREDENTIALS` if set, else
   `<repo>/.r2-credentials.json`, else `<repo>/.r2-credentials/r2.json`, else
   `~/.config/companyintel/r2-credentials.json`;
3. otherwise no credentials: tools exit **2** with the setup recipe and never guess.

Guarantees this module keeps (asserted by tests):

- no credential **value** is ever returned in a status object, thrown message or log line — only
  presence booleans, the (non-secret) account id, the endpoint host, the bucket and the region;
- the endpoint and bucket are validated, and an endpoint whose first label disagrees with the
  account id is rejected instead of silently used;
- `--secret`/`--access-key`-style arguments are refused, so nothing lands in shell history or `ps`;
- nothing here is imported by `src/**` (the browser bundle) or `worker/**` (the deployed Worker),
  and no `VITE_*` variable is read: a secret cannot reach the browser through this path.

Do not paste these values into chat, into a hosting provider's Frontend/Backend environment panel,
into `wrangler.toml` or into a tracked source file: the production Worker uses the `COMPANY_DATA`
binding and needs no keys at all. See `docs/r2-connection.md`.

If no credentials are configured, `publish` stops with instructions, and the verification scripts
exit 2 with the setup recipe.

## 6. Read-only R2 probe (`probe/wrangler.toml`)

A separate, development-only Worker used by `bun run verify:r2:remote`. It is never deployed.

```toml
name = "companyintel-r2-probe"
main = "src/index.ts"
workers_dev = false          # nothing is ever served publicly

[[r2_buckets]]
binding = "COMPANY_DATA"     # same binding name as the app, same bucket
bucket_name = "company-intel-data"
remote = true                # Worker runs locally; the binding talks to the real bucket

[vars]
ENVIRONMENT = "development"  # the probe refuses to answer if this is "production"
RAW_PREFIX = "raw/"
MAX_RAW_OBJECTS = "25"       # objects per page, and objects reported
MAX_LIST_LIMIT = "100"
MAX_READ_BYTES = "65536"     # cap for the bounded per-source body read
MAX_SAMPLE_BYTES = "8388608" # cap for the bounded schema sample
MAX_SCHEMA_ROWS = "2000"
```

`remote = true` is Wrangler 4's per-binding remote access: `wrangler dev` runs the Worker on your
Mac while that one binding talks to the real bucket. Two consequences worth knowing:

- **never pass `--local`** when starting it — that flag disables remote bindings and would swap the
  real bucket for an empty local simulation, and the report would be a lie;
- the probe's query parameters may only ask for **less** than these caps; `MAX_LIST_LIMIT` is the
  absolute ceiling for `?max=`, so a 50 GB object can never be downloaded.

The bounds are deliberately duplicated in code as absolute ceilings
(`ABSOLUTE_MAX_*` in `probe/src/index.ts`) so a mistyped config cannot raise them. Tests assert the
clamping, the production guard, the 405 on write methods, and that no `put`/`delete`/`upload` call
exists in the probe or in `src/shared/r2/`.

## 7. Node / tooling

- Node.js 20+ (or Bun 1.1+). The indexer uses only Node built-ins plus the S3 API over HTTPS.
- Install dependencies once: `bun install` (or `npm install`).
- Commands are documented in `README.md`; indexing details are in `docs/indexing.md`; the R2
  connection paths are in `docs/r2-connection.md`.
