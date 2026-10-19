# Deployment (Cloudflare Workers + R2 + Access)

Written for someone who has not deployed to Cloudflare before. Do the steps in order; each one
says what you should see when it worked.

**You will not paste any secret into a chat or a file in this repository.** Secrets are typed
into your own terminal (`wrangler secret put`) or created in the Cloudflare dashboard.

---

## 0. What you need

- A Cloudflare account with the `company-intel-data` R2 bucket (already created).
- Node.js 20+ installed: <https://nodejs.org> (accept the defaults, then close and reopen
  PowerShell).
- This repository on your Windows machine.

```powershell
node --version      # v20.x or newer
bun --version       # or: npm --version
```

## 1. Install dependencies and check the project

```powershell
cd C:\path\to\companyintel
bun install
bun run check          # typechecks (frontend, worker, indexer) + full test suite
```

Expected: `103 pass` and no TypeScript errors. If this fails, fix it before deploying.

## 2. Log in to Cloudflare from the command line

```powershell
bunx wrangler login
```

A browser window opens; approve access. You should see `Successfully logged in`.

## 3. Confirm the R2 bucket and the raw files

```powershell
bunx wrangler r2 bucket list
```

Expected: a line containing `company-intel-data`.

```powershell
bunx wrangler r2 object list company-intel-data --prefix raw/
```

Expected: your two CSV objects with their sizes. `raw/` is how the app refers to the original
uploads; the Worker never writes there. You can also verify object sizes and checksums with the
included helper while your rclone credentials are exported for the session:

```powershell
bun scripts/verify-raw.mjs
```

## 4. Set the Worker secrets

Run each line, then paste the value when prompted (paste is hidden). Press Enter after each.

```powershell
bunx wrangler secret put CF_ACCESS_TEAM_DOMAIN   # e.g. myteam.cloudflareaccess.com
bunx wrangler secret put CF_ACCESS_AUD           # from step 6, the Access application AUD
bunx wrangler secret put ALLOWED_EMAILS          # your email address (comma-separated if more than one)
```

`CF_ACCESS_AUD` comes from step 6. You can set it after creating the Access application and
re-run the command; nothing else needs to change.

Never set `DEV_ALLOW_UNAUTHENTICATED` in production. The Worker refuses the bypass when
`ENVIRONMENT=production`, and it fails closed when Access is unconfigured.

## 5. Build the frontend

```powershell
bun run build
```

Expected: Vite writes `dist/`. `wrangler.toml` serves that directory through the `ASSETS`
binding with an SPA fallback, so `/companies/...` deep links work.

If you want the deployed UI to talk to the Worker API, set `VITE_API_MODE=worker` in your
build environment (and `VITE_API_BASE_URL` only if the API lives on another origin). Without
it the deployed bundle falls back to the clearly-labelled synthetic sample mode.

## 6. Create the Cloudflare Access application (this is what makes the app private)

1. Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Name it `CompanyIntel`.
3. **Application domain**: add the Worker hostname you will deploy to
   (`companyintel.<your-subdomain>.workers.dev`) **and** your custom domain if you attach one.
   Add the preview URL pattern too if you use preview deployments.
4. **Session duration**: 24 hours (or your preference).
5. **Policies**: add one policy — Action `Allow`, Include `Emails`, value = your email address.
   Leave no `Bypass` policy on any hostname.
6. Save. On the application's **Overview** page, copy the **AUD tag** (a long hex string).
7. Note your **team domain** from **Zero Trust → Settings** (`<team>.cloudflareaccess.com`).
8. Back in the terminal, set the AUD you just copied:

```powershell
bunx wrangler secret put CF_ACCESS_AUD
```

**Also protect alternate hostnames.** `wrangler.toml` already sets `workers_dev = false` for
production, so no `*.workers.dev` alias exists for this Worker — you must add your custom-domain
`[routes]` entry (there is a commented example in the file) and make sure the Access application
covers it. Only `env.development` keeps the alias, for `wrangler dev`. An unprotected alternate
hostname is a bypass; the Worker also fails closed on any hostname, because every `/api/*` route
verifies the Access JWT itself.

## 7. Deploy

```powershell
bunx wrangler deploy
```

Expected output ends with `Deployed companyintel triggers` and a URL. Visit it: Cloudflare
Access asks you to authenticate with your email OTP or SSO **before** the app loads. That login
page appearing is the proof that Access is protecting the origin.

## 8. Verify the deployment

```powershell
# Unauthenticated API call must be rejected (expect 401/403, never 200)
curl.exe -i https://companyintel.<your-subdomain>.workers.dev/api/health

# Behind Access (browser session cookie present), the same route returns {"status":"ok"}
```

In the browser, signed in:

1. `/api/health` → `{"status":"ok"}`.
2. `/dataset` → shows bucket connectivity, source files, active version (or "Dataset not
   indexed" before your first publish).
3. `/companies` → searches return results from the active version.
4. `/leads` → saving a company, changing its status and reloading keeps the change
   (R2-backed persistence).
5. `/exports` → generate a CSV export and download it.

## 9. Publish your first dataset

Follow `docs/indexing.md` (profile → samples → approval gate → full run → validate → publish).
Until you publish, the API returns `503 dataset_unavailable` and the UI says the dataset is not
indexed — that is the intended behaviour, not a bug.

## 10. Cloud indexing container (optional, needed for the 64 GB run)

The application deploys and serves without a container. The container is what can index
the full corpus without your computer. `wrangler.toml` already contains the container
(`[[containers]]`), the `INDEXER_CONTAINER` Durable Object binding and its migration, and
the root `Dockerfile` is the image.

**Prerequisites:** Docker (or a compatible builder) running on the deploying machine.
`wrangler deploy` builds the image locally and pushes it to Cloudflare's registry on the
first deploy; later deploys push only changed layers.

1. Build and validate the image locally first (this is the step that proves the image is
   self-contained):

   ```powershell
   docker build --platform linux/amd64 -t companyintel-indexer .
   docker run --rm -p 8080:8080 companyintel-indexer
   curl.exe localhost:8080/health
   ```

   Expected: `{"ok":true,...}`.

2. Set the container's R2 credentials as Worker secrets. The container DO forwards them
   to the container at start; they are never returned to a browser and are never in this
   repository:

   ```powershell
   bunx wrangler secret put R2_ACCOUNT_ID
   bunx wrangler secret put R2_ACCESS_KEY_ID
   bunx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

   Use a token scoped to **Object Read & Write on `company-intel-data` only** (least
   privilege). Do not reuse your account-wide token.

3. Optionally restrict the control plane to specific operators:

   ```powershell
   bunx wrangler secret put INDEXING_ADMIN_EMAILS   # comma-separated emails
   ```

   Every `/api/cloud/*` route already requires a valid Cloudflare Access JWT and rejects
   cross-origin requests; this variable is a second, narrower allowlist.

4. Deploy:

   ```powershell
   bun run build
   bunx wrangler deploy
   ```

   Expected: Wrangler builds the image, pushes it, deploys the Worker, and prints the
   container binding. `/indexing` now shows `containerBound: true` from `/api/cloud/jobs`.

5. Run a bounded benchmark from `/indexing` (1–256 MB per source). Then start Cloud
   Pass 2 from the same panel. Verify the segments first; activate only a completed
   **full** run.

**Not verified in this workspace:** Docker is unavailable, there is no Cloudflare API
 token, and no deploy was attempted. The configuration matches Cloudflare's documented
 schema, and the same code path was exercised against real R2 objects outside the
 container (see `docs/cloud.md`). Treat the first real deploy as unverified until it
 appears in the Cloudflare dashboard.

## 11. Rollback

Dataset Management (`/dataset`) lists known versions and lets you re-point the active version
after a confirmation step. Manually, that pointer is a single object:

```powershell
# Inspect the pointer (read-only)
bunx wrangler r2 object get company-intel-data/manifests/active.json --pipe
```

Re-point it with the app UI (recommended) or by re-running
`bun tools/indexer/src/cli.ts publish --config <cfg> --version <previous> --yes`.
Nothing in the old version is deleted when a new one is published, so rollback is immediate.

## Preserving the code without GitHub

If repository synchronization is unavailable, the workspace is still the authoritative
copy. A non-destructive archive you can store anywhere:

```powershell
tar --exclude node_modules --exclude .git --exclude ".indexer*" `
    --exclude ".r2-credentials.json" -czf companyintel-source.tgz .
```

Deploy directly from this workspace with `bun run build` and `bunx wrangler deploy`; the
container image is built from the root `Dockerfile` during that deploy. No indexing job
has to run on a personal machine for either step.

## Notes on this preview environment

This workspace previews the React frontend. It cannot run a Workers runtime or a 60 GB local
indexing job, so:

- the preview runs against the clearly-labelled synthetic sample dataset (`local` API mode),
- the production Worker code, indexer and deployment config in this repository are the real
  artifacts and are typechecked and tested here,
- nothing in the preview claims a successful R2 connection or a completed real indexing run.

Cloudflare Workers (the V8 isolate runtime) and R2 are the only runtime and storage for
production; no other database is used, installed or required.
