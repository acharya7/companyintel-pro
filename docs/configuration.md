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
    { "id": "csv1", "path": "D:/company-intel/raw/companies_part1.csv", "encoding": "utf8", "delimiter": "," },
    { "id": "csv2", "path": "D:/company-intel/raw/companies_part2.csv", "encoding": "utf8", "delimiter": "," }
  ],
  "workDir": ".indexer-work",     // disk-backed spool/checkpoint area
  "outputDir": ".indexer-output", // generated objects, one file per R2 object
  "partitions": 256,
  "shards": { "exact": 512, "prefix": 256, "token": 256, "trigram": 512, "ids": 256 },
  "upload": { "enabled": false, "bucket": "company-intel-data" }
}
```

- **File paths**: point them at your real CSVs. Use forward slashes on Windows
  (`D:/data/part1.csv`). `profile` warns when a path does not exist instead of guessing.
- **`columns`** (optional, per source): override any header→canonical-field mapping that the
  profiler got wrong, e.g. `"columns": { "companyname": "Organization", "email": "Email 1" }`.
- **`upload.bucket`** must stay `company-intel-data` unless you deliberately create another
  bucket (not necessary).
- Object sizes/partition counts inside a version are recorded in `directory.json`, so the
  Worker derives the same keys without configuration.
- R2 credentials for upload/publish are **environment variables only** (see below); they are
  never written to this file.

## 5. R2 credentials for the indexer (local machine only)

Used by `run --upload` and `publish`. You configured these already with rclone; the indexer
reads the same S3-compatible credentials:

```powershell
# Windows PowerShell — set for the current session only
$env:R2_ACCOUNT_ID="<your account id>"
$env:R2_ACCESS_KEY_ID="<access key id>"
$env:R2_SECRET_ACCESS_KEY="<secret access key>"
```

Never commit these, never paste them into chat. If they are absent, `publish` stops and tells
you to upload with rclone and then write `manifests/active.json` manually.

## 6. Node / tooling

- Node.js 20+ (or Bun 1.1+). The indexer uses only Node built-ins plus the S3 API over HTTPS.
- Install dependencies once: `bun install` (or `npm install`).
- Commands are documented in `README.md`; indexing details are in `docs/indexing.md`.
