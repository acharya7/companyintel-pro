# Connecting R2 — what is real, what is not

Short version: **the production Worker reaches your bucket through the native R2
binding `COMPANY_DATA` and needs no keys at all.** The one-command connection test
(`bun run verify:r2:remote`, §2) uses that same binding through a local, read-only
probe Worker, so verifying the real bucket needs **no R2 access key and no secret**.
The only thing that ever needs S3 credentials is the local indexer's *upload*, and
the indexer reading Mode B sources — those credentials belong in a terminal on your
own machine, never in the Freebuff environment panel. Nothing in this workspace has
read your bucket yet.

## 1. What was actually checked in this workspace (evidence, not assumption)

| Check | How | Result |
| --- | --- | --- |
| Does the app depend on Convex? | `convex` is absent from `package.json`; no `src/convex/`; no `convex` import in `src/`, `worker/`, `tools/`, `tests/` | **No Convex dependency at all** |
| Where does the Worker get its configuration? | `worker/src/env.d.ts` + `wrangler.toml` | Bindings/vars/secrets only: `COMPANY_DATA`, `ASSETS`, `ENVIRONMENT`, `APP_VERSION`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS`, `DEV_ALLOW_UNAUTHENTICATED`, `MAX_SEARCHES_PER_MINUTE` |
| Are R2 credentials visible to this workspace's processes? | `bun scripts/verify-raw.mjs` | **Exit 2**: "R2 credentials are not set for this terminal session" — so `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are **not** present here |
| Can this workspace make server-side R2 S3 requests? | The verification scripts run on Node/Bun and sign SigV4 themselves; exercised end to end over a stub transport (`tests/verify-raw-script.test.ts`, `tests/profile-raw-script.test.ts`) | **Yes, technically** — but see §4: it still needs credentials supplied to that process |
| Does the preview depend on Convex? | `src/lib/api/client.ts` | **No.** With no `VITE_API_MODE` set it serves the bundled synthetic sample dataset (`local` mode) and labels every screen as sample data |
| Does the Worker ever read an S3 secret? | `tests/worker-r2-binding.test.ts` scans every `worker/**/*.ts` | **No** — no `R2_*` secret, no `cloudflarestorage.com`, no `process.env` |

The Frontend tab still lists `VITE_CONVEX_URL` / `CONVEX_DEPLOYMENT` because the
project template ships those lines. Nothing in this codebase reads them.

## 2. The fastest path: the read-only probe (no S3 keys)

`bun run verify:r2:remote` starts an **isolated, read-only probe Worker** on your Mac
(`probe/wrangler.toml`) bound to `127.0.0.1:8788`, with the native `COMPANY_DATA` binding pointed at
the real `company-intel-data` bucket through `remote = true`. Your existing Wrangler login is the
only credential involved; the probe is never deployed and cannot write (see §6 for the guards that
prove it).

```bash
cd /path/to/companyintel-pro-main          # the folder you extracted
bun run verify:r2:remote                   # human-readable report
bun run verify:r2:remote --json > raw-verification.json     # one share-safe JSON report
bun run verify:r2:remote --keys raw/<file1>.csv,raw/<file2>.csv   # name the sources explicitly
```

Requirements: Wrangler 4.x (`bunx wrangler --version`), a completed `bunx wrangler login`, Bun
installed, and port 8788 free. Nothing else — no API token, no key, no secret.

What one run does, and nothing more:

1. starts the probe locally (`wrangler dev --config probe/wrangler.toml --ip 127.0.0.1 --port 8788`)
   and waits for `/health`;
2. **one bounded `raw/` listing** (≤ 25 objects per page, ≤ 2 pages, largest first) with real keys,
   byte sizes and timestamps;
3. names the two source objects (or the `--keys` you gave), then does a `HEAD` and a **1 KB ranged
   body read** per source to prove it is readable — never a whole-file download;
4. a **6 MB bounded sample** per source for a schema report: encoding, delimiter, header line,
   column names, fill rates, type guesses and per-column canonical-field suggestions with a
   confidence and the evidence, plus a ready-to-paste `columns` override for the indexer;
5. the published-dataset state (`manifests/active.json` → manifest / validation / directory), or
   "none" if nothing is published;
6. stops the probe and exits **0** verified, **1** problem (missing/unreadable/not published),
   **2** the probe could not be started.

The report contains object keys, sizes, ETags, timestamps, headers, fill rates and mappings — and
**no cell values, names, emails or phone numbers**.

Expected output, in outline:

```
CompanyIntel R2 probe — companyintel-r2-probe
checked at 2026-…   read-only: no writes, no uploads, no deletes

Bucket company-intel-data — READABLE with the native COMPANY_DATA binding (no S3 keys used)
Objects under raw/: 2 read over 1 page(s), showing up to 25
   50.00 GB  raw/<file2>.csv   2026-09-12T10:00:00.000Z
   10.00 GB  raw/<file1>.csv   2026-09-12T09:00:00.000Z

Source selection: two-largest-csv
Source objects
  ok       raw/<file2>.csv  50.00 GB  etag=…  read 1.00 KB of the body
  ok       raw/<file1>.csv  10.00 GB  etag=…  read 1.00 KB of the body

Published dataset
  none — the app will report "Dataset not indexed" until a version is published

Schema — raw/<file2>.csv
  encoding          UTF-8 (no BOM) (encoding utf-8, confidence high)
  delimiter         "," (confidence high)
  header line       1   columns 14
  columns (no cell values are included): …
  mapping suggestions: …
  suggested indexer columns override: {…}

VERIFIED: every expected object is present and readable, and the published dataset is intact.
```

If it fails:

| Symptom | What it means / what to do |
| --- | --- |
| `The probe did not become ready within …s` | Read the wrangler lines it prints. Usually `bunx wrangler login` has not been run in this terminal. |
| `Port 8788 is already in use` | Re-run with `--port 8789` (free the port, or keep the other process). |
| `The probe exited before it answered` | Wrangler older than 4.x, or the account cannot see the bucket. Check `bunx wrangler --version` and `bunx wrangler r2 bucket list`. |
| `remote = true` rejected by your Wrangler | Your Wrangler predates remote bindings; update Wrangler, or use §5 (S3 keys) for this one check. |
| The report says `MISSING` for a source | The object key is not in the bounded listing. Copy the exact keys from the listing and pass `--keys`. Nothing was modified. |
| You want to watch it while it runs | `bun run verify:r2:remote --keep-open` leaves the probe on `127.0.0.1:8788`; press Ctrl-C to stop it. |

This is the check to run first. `bun run verify:r2` (§5) is the S3-key equivalent and remains useful
as a fallback, and because the indexer needs those same keys for its upload stage.

## 3. The Freebuff panel: what each tab can and cannot do

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

## 4. The correct, supported credential path (unchanged by any of the above)

| Stage | How R2 is reached | Credentials |
| --- | --- | --- |
| Production Worker (every search, every shard read) | Native binding `COMPANY_DATA` → `company-intel-data` (`wrangler.toml`) | **None. No keys exist in the Worker.** |
| Phase A verification + schema profiling (**recommended**) | `bun run verify:r2:remote` → the local read-only probe Worker with the same binding (`remote = true`) | **None.** Your Wrangler login only |
| Phase A alternative | `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs` on your machine | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in that shell session only |
| Indexing Mode B (reading the two CSVs straight from R2) | `tools/indexer` with `r2://company-intel-data/raw/…` sources | the same three variables (Object Read is enough) |
| Full indexing upload | `tools/indexer` on your machine (`run --upload`, `publish`) | same three variables (Object Read & Write), or rclone instead |
| Worker secrets (Access) | `wrangler secret put …` on your machine | never in this repo |

macOS, only if you prefer the S3-key path over the probe (§2) — session only, closes with the
window:

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

## 5. What the S3-key connection test does

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

## 6. Answers to the ten questions

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
   `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs`, the indexer's `r2://` (Mode B)
   sources and its `--upload`/`publish`. The Worker consumes **no** credentials — it
   uses the `COMPANY_DATA` binding, and so does the read-only probe.
7. **How do I test the connection securely?** Run `bun run verify:r2:remote --json`
   in your own terminal (§2). It needs no keys at all: it uses your Wrangler login and
   the same native binding the deployed app uses. Send back the JSON — it contains
   names, sizes, ETags, headers, fill rates and mappings, and no secrets or cell values.
8. **If no — simplest safe alternative on macOS?** The probe is the simplest path;
   its zero-config fallbacks are `rclone lsl r2:company-intel-data/raw/` and
   Cloudflare dashboard → R2 → `company-intel-data` → Objects → prefix `raw/`, which
   need no keys either. The S3-key scripts (§5) stay available if you prefer them.
9. **What can be done automatically here?** Everything except running the probe against
   your account: the probe Worker, its bounds, the bounded sample/schema reports, the
   mapping suggestions, the binding config, the single-command runner, and the tests
   that prove the Worker and the probe never touch a key and never write.
   Proof so far: `tests/r2-probe.test.ts` (routes, bounds, no writes, no cell values),
   `tests/r2-probe-schema.test.ts` (encoding/delimiter/multiline/mapping), and
   `tests/verify-r2-remote-script.test.ts` (the runner's exit codes 0/1/2 over a stub
   probe), plus `tests/worker-r2-binding.test.ts` for the binding-only rule.
   **None of that is evidence about your bucket.**
10. **Done, with real requests:** the fixed credentials in the private `.r2-credentials.json` were
    used to run `bun run r2:doctor` (signed LIST accepted), `bun run r2:schema` (both files sampled),
    `bun run verify:r2` (inventory, sizes, ETags, body reads, dataset state) and `bun run index:profile`
    (preflight over the real objects). Results: `docs/verification.md` §Phase A. The alternative
    `bun run verify:r2:remote` path (Worker binding, no keys at all) still works and needs only your
    authenticated Wrangler session.

## 7. Status, and what is still yours to do

- **Your bucket is verified.** Phase A holds live results now: `raw/file1.csv` (10,223,471,749 B)
  and `raw/file2.csv` (54,038,527,871 B), both read with signed ranged GETs, no published dataset,
  and the two schemas mapped (`docs/verification.md` §Phase A).
- **Credentials are configured server-side only:** the private, git-ignored `.r2-credentials.json`
  (mode 600) is read automatically by the indexer and the verification scripts. Nothing of it is
  imported by `src/**` (browser bundle) or `worker/**` (deployed Worker), no `VITE_*` variable is
  read, and `bun run r2:doctor` refuses to print a report in which a credential value survived
  redaction. The file must be recreated on your own machine — it is git-ignored, so it was never
  and will never be pushed (see `docs/configuration.md` §5).
- `wrangler.toml` now sets `workers_dev = false` for production (only `env.development` keeps the
  alias), so the app is **not** reachable on an unmanaged `*.workers.dev` hostname. Add your
  custom-domain `[routes]` entry before deploying; the Worker fails closed on any hostname because
  it verifies the Cloudflare Access JWT itself for every `/api/*` route.
- Still pending and waiting on you: the 1,000,000-record sample, the full 64.26 GB run with
  `--upload`, `publish`, and the production deploy. No full indexing, no deployment, no paid service
  and no bucket mutation was started.
