# Connecting R2 — what is real, what is not

Short version: **the production Worker reaches your bucket through the native R2
binding `COMPANY_DATA` and needs no keys at all**; the only thing that ever needs
S3 credentials is the one-time local indexing upload, and those credentials belong
in a terminal on your own machine — not in the Freebuff environment panel. Nothing
in this workspace has read your bucket yet.

## 1. What was actually checked in this workspace (evidence, not assumption)

| Check | How | Result |
| --- | --- | --- |
| Does the app depend on Convex? | `convex` is absent from `package.json`; no `src/convex/`; no `convex` import in `src/`, `worker/`, `tools/`, `tests/` | **No Convex dependency at all** |
| Where does the Worker get its configuration? | `worker/src/env.d.ts` + `wrangler.toml` | Bindings/vars/secrets only: `COMPANY_DATA`, `ASSETS`, `ENVIRONMENT`, `APP_VERSION`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS`, `DEV_ALLOW_UNAUTHENTICATED`, `MAX_SEARCHES_PER_MINUTE` |
| Are R2 credentials visible to this workspace's processes? | `bun scripts/verify-raw.mjs` | **Exit 2**: "R2 credentials are not set for this terminal session" — so `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are **not** present here |
| Can this workspace make server-side R2 S3 requests? | The verification scripts run on Node/Bun and sign SigV4 themselves; exercised end to end over a stub transport (`tests/verify-raw-script.test.ts`, `tests/profile-raw-script.test.ts`) | **Yes, technically** — but see §3: it still needs credentials supplied to that process |
| Does the preview depend on Convex? | `src/lib/api/client.ts` | **No.** With no `VITE_API_MODE` set it serves the bundled synthetic sample dataset (`local` mode) and labels every screen as sample data |
| Does the Worker ever read an S3 secret? | `tests/worker-r2-binding.test.ts` scans every `worker/**/*.ts` | **No** — no `R2_*` secret, no `cloudflarestorage.com`, no `process.env` |

The Frontend tab still lists `VITE_CONVEX_URL` / `CONVEX_DEPLOYMENT` because the
project template ships those lines. Nothing in this codebase reads them.

## 2. The Freebuff panel: what each tab can and cannot do

- **Backend tab** — its variables belong to the project's Convex deployment (the UI
  reports that deployment is paused). This app has no Convex runtime, so a value
  placed there has **no code path** to the Worker or to the local scripts. Putting
  `R2_ACCESS_KEY_ID` there would store a live secret somewhere it is never used.
- **Frontend tab** — these are build-time `VITE_*` variables **shipped to the
  browser**. Never put a secret here. The only variables that belong here are
  non-secret routing choices: `VITE_API_MODE` (`worker` or `local`) and
  `VITE_API_BASE_URL`.
- **The workspace terminal** — can run the verification scripts, but the credentials
  would have to be typed into a command in this chat to reach it. **Don't.**
  Treat that as the boundary: secrets go into your own terminal, never into a
  message.

## 3. The correct, supported credential path (unchanged by any of the above)

| Stage | How R2 is reached | Credentials |
| --- | --- | --- |
| Production Worker (every search, every shard read) | Native binding `COMPANY_DATA` → `company-intel-data` (`wrangler.toml`) | **None. No keys exist in the Worker.** |
| Phase A verification + schema profiling | `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs` on your machine | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in that shell session only |
| Full indexing upload | `tools/indexer` on your machine (`run --upload`, `publish`) | same three variables, or rclone instead |
| Worker secrets (Access) | `wrangler secret put …` on your machine | never in this repo |

macOS (your machine, terminal session only — closes when the window does):

```bash
cd /path/to/company-intel          # the repository this preview builds from
export R2_ACCOUNT_ID="<account id>"
export R2_ACCESS_KEY_ID="<access key id>"
export R2_SECRET_ACCESS_KEY="<secret access key>"

# read-only checks; no writes, no deployment, no paid service
bun scripts/verify-raw.mjs --json > raw-verification.json     # inventory + dataset state
bun scripts/profile-raw.mjs --json > raw-schema-reports.json  # both schema reports
unset R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

# optional: confirm presence without ever printing a value
bun -e 'console.log({account: !!process.env.R2_ACCOUNT_ID, key: !!process.env.R2_ACCESS_KEY_ID, secret: !!process.env.R2_SECRET_ACCESS_KEY})'
```

Without the repository you can still do the first half of Phase A — names and sizes —
with either of these, and neither needs S3 keys:

```bash
rclone lsl r2:company-intel-data/raw/        # rclone already configured on your machine
# or: Cloudflare dashboard → R2 → company-intel-data → Objects → prefix raw/
```

The schema reports do need the scripts, because they need a profiled sample.

## 4. What the connection test actually does

`bun scripts/verify-raw.mjs` (read-only; `bun run verify:r2` is the same thing):

1. proves `company-intel-data` is readable with the credentials in the session and
   says so plainly if it is not (HTTP status included, secrets never printed);
2. performs **one** bounded `LIST` of `raw/`, largest object first, and shows at most
   **25** objects with their real names, byte sizes and timestamps;
3. decides which objects are the sources — the two largest `.csv` files, or the
   `--keys raw/a.csv,raw/b.csv` you name explicitly. Auto-selection is labelled as
   automatic (`selection.mode`), never presented as fact;
4. for each source: a `HEAD` (size/ETag) plus a **1 KB ranged GET** to prove the body
   is readable. A 10 GB or 50 GB object is never downloaded;
5. reports the published dataset (`manifests/active.json` → manifest / validation /
   directory) if one exists, and says "none" if it does not;
6. reports missing objects, missing manifests and failed validation as **problems**
   (exit code 1) instead of assuming them away. An unusable credential set exits 1
   too; absent credentials exit 2.

`bun scripts/profile-raw.mjs` samples the first 6 MB of each source by range, trims
the sample back to the last complete record (a range boundary can land inside a
quoted multiline row), and prints both schema reports plus a suggested indexer
`columns` mapping. `--json` gives one share-safe report: headers, fill rates and
mappings, **no cell values**.

## 5. Answers to the ten questions

1. **Can I use Backend → Add Variable for R2 credentials?** No.
2. **Is that section tied to the paused Convex deployment?** Yes — it is Convex's
   environment, which this app never reads (there is no Convex code here at all).
3. **If yes, which variables must I create?** None there. Do not put R2 credentials
   in the Backend tab — they would sit unused in a service this app does not use.
4. **What value belongs in each variable?** Not applicable to that panel. The three
   that the local scripts read are `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`; `R2_BUCKET_NAME`/`company-intel-data` and region `auto`
   are already fixed in code (`tools/indexer/src/r2.ts` builds
   `https://<account>.r2.cloudflarestorage.com` and signs with region scope `auto`),
   so no `R2_ENDPOINT`/`R2_REGION` variables are needed or read.
5. **Which credentials must be secret?** All three. `R2_SECRET_ACCESS_KEY` is the
   real secret; the access key id and account id are still not for the Frontend tab.
6. **What code consumes them?** Only local, non-deployed code:
   `tools/indexer/src/r2.ts` → `credentialsFromEnv()`, used by
   `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs` and the indexer's
   `--upload`/`publish`. The Worker consumes **no** credentials — it uses the
   `COMPANY_DATA` binding.
7. **How do I test the connection securely?** In your own terminal, session-scoped
   exports (or rclone), then `bun scripts/verify-raw.mjs --json`. Send back the JSON:
   it contains names, sizes, ETags and counts — no secrets, no cell values.
8. **If no — simplest safe alternative on macOS?** Your own terminal session (above).
   Zero-config fallback: `rclone lsl r2:company-intel-data/raw/`, which needs no S3
   keys at all and already works for you.
9. **What can be done automatically here?** Everything except supplying the
   credential: scripts, bounds, sample trimming, schema reports, mapping suggestions,
   the R2 binding config, and the tests that prove the Worker never touches a key.
   Proof so far: `tests/verify-raw-script.test.ts` and
   `tests/profile-raw-script.test.ts` run the real scripts end to end over a stub
   transport (bounded LIST, 25-object bound, 1 KB / 6 MB ranged reads, missing-object
   handling, exit codes, no secrets in output) and `tests/worker-r2-binding.test.ts`
   asserts the binding-only rule. **None of that is evidence about your bucket.**
10. **Single next manual action:** in your own terminal, export the three variables
    and run `bun scripts/verify-raw.mjs --json > raw-verification.json`, then send me
    that file's contents. That is the one step that turns Phase A from "ready" into
    "verified", and it is read-only.

## 6. Still pending, and one config item to confirm

- **Nothing about your bucket is verified yet.** Phase A stays `NOT VERIFIED` until
  the run in §5.10 happens, and I will not fill in filenames, sizes or mappings
  before then.
- `wrangler.toml` sets `workers_dev = true`, so the app is also reachable at its
  `*.workers.dev` hostname. The Worker itself fails closed (it requires a valid
  Cloudflare Access JWT for every `/api/*` route, even there), but when you configure
  Access, protect **both** hostnames — or disable the `workers.dev` route — so the
  edge policy and the app agree. Not changed here: it is a deployment decision.
- No full indexing, no deployment, no paid service, no bucket change was started.
