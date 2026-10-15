# Configuration

Everything the app needs is configuration or an environment variable. No secret is ever
hardcoded, and no secret belongs in this document, in `wrangler.toml`, or in chat.

## 1. Frontend API mode

The browser either talks to the deployed Worker or to the bundled **synthetic sample
dataset** used for previewing the UI. The mode is explicit, never an accidental fallback:

| Variable | Value | Effect |
| --- | --- | --- |
| `VITE_API_MODE` | `worker` | All data comes from the Cloudflare Worker API (`/api/...`). This is production behaviour. |
| `VITE_API_MODE` | `local` | Synthetic sample data only. Clearly labelled in the UI as sample/origin. |
| `VITE_API_BASE_URL` | e.g. `https://companyintel.example.workers.dev` | Origin of the Worker API. Only needed when the frontend is served from a different origin. |

If neither is set, the app runs in `local` mode and every screen shows a *sample data* origin
badge — it never pretends to be connected to R2. Set these in your host's environment/Keys
panel; the repository's `.env` files are managed outside the code.

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
    // MODE B: read straight from R2 (bounded ranged reads; needs R2_* credentials)
    { "id": "csv1", "path": "r2://company-intel-data/raw/companies_part1.csv", "encoding": "utf8", "delimiter": "," },
    { "id": "csv2", "path": "r2://company-intel-data/raw/companies_part2.csv", "encoding": "utf8", "delimiter": "," }
    // MODE A instead: a local path, e.g. "D:/company-intel/raw/companies_part1.csv"
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
- **Mode B credentials**: the three `R2_*` variables below are required when any source is an
  `r2://` URL; Wrangler's login cannot be handed to the indexer. Object Read is enough to index,
  Read & Write only for `--upload`/`publish`. Details and the least-privilege steps:
  `docs/indexing.md`.
- **`columns`** (optional, per source): override any header→canonical-field mapping that the
  profiler got wrong, e.g. `"columns": { "companyname": "Organization", "email": "Email 1" }`.
- **`upload.bucket`** must stay `company-intel-data` unless you deliberately create another
  bucket (not necessary).
- Object sizes/partition counts inside a version are recorded in `directory.json`, so the
  Worker derives the same keys without configuration.
- R2 credentials for Mode B reads and for upload/publish are **environment variables only** (see
  below); they are never written to this file.

## 5. R2 credentials for the indexer and verification scripts (local machine only)

Used by Mode B (`r2://`) sources, `run --upload`, `publish`, `scripts/verify-raw.mjs` and
`scripts/profile-raw.mjs`. **Not** used by the read-only probe or the deployed Worker, which use
the native `COMPANY_DATA` binding:

```bash
bun run verify:r2:remote          # no keys at all — your Wrangler login + the R2 binding
```
You configured these already with rclone; the local code reads the same S3-compatible
credentials from the environment — never from a file in this repository:

```powershell
# Windows PowerShell — set for the current session only
$env:R2_ACCOUNT_ID="<your account id>"
$env:R2_ACCESS_KEY_ID="<access key id>"
$env:R2_SECRET_ACCESS_KEY="<secret access key>"
```

```bash
# macOS / Linux — same three, scoped to this shell session only
export R2_ACCOUNT_ID="<account id>"
export R2_ACCESS_KEY_ID="<access key id>"
export R2_SECRET_ACCESS_KEY="<secret access key>"
```

No `R2_ENDPOINT`, `R2_REGION` or `R2_BUCKET_NAME` variable is read: the endpoint is derived
from the account id, the signature scope is `auto`, and the bucket defaults to
`company-intel-data` (`tools/indexer/src/r2.ts`).

Never commit these, never paste them into chat, and do not enter them in a hosting
provider's Frontend/Backend environment panel: the production Worker uses the
`COMPANY_DATA` binding and needs no keys, and the Backend panel of a Convex-backed project
is read by Convex, not by this app. See `docs/r2-connection.md`.

If they are absent, `publish` stops and tells you to upload with rclone and then write
`manifests/active.json` manually, and the verification scripts exit 2 with setup instructions.

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
