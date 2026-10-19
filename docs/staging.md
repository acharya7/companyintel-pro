# Staging deployment and the controlled real-cloud benchmark

This is the operating document for the next step: get the cloud indexing code into a
Cloudflare build, deploy it **as a staging Worker with its own container**, and run one
small, bounded, real benchmark. Nothing here starts the full corpus, and nothing here
publishes the application.

Everything in this document is checked into the workspace. Nothing is deployed yet.

## 1. Status at a glance

| Item | State |
| --- | --- |
| Cloud Pass 1 (R2 chunker + segments + checkpoints) | implemented, tested, verified against real R2 |
| Cloud Pass 2 (partition reduce + streaming shard merge) | implemented, tested, verified against real R2 |
| Production build (`tsc -b && vite build`) | passes in this workspace (`dist/` built) |
| Test suite | `613 pass, 0 fail` (51 files) |
| Lint / typechecks (app, worker, indexer, probe) | pass |
| `wrangler deploy --dry-run` (production and staging) | pass; container + bindings resolve |
| Staging Worker config (`wrangler.staging.toml`) | written, dry-run validated (`companyintel-staging` + `INDEXER_CONTAINER` + `COMPANY_DATA` + `staging/active.json` all resolve) |
| Staging isolation tests | `tests/staging-isolation.test.ts` (drives the real admin router) and `tests/staging-config.test.ts` |
| GitHub synchronization | **blocked in this environment** (`git` commands are refused); see §3 |
| Actual Cloudflare deploy | **not done** (no API token, no Docker here) |
| Full 64.26 GB indexing | **not started, not authorised** |

## 2. What the staging deployment is

`wrangler.staging.toml` deploys a **separate Worker** called `companyintel-staging`:

* its own script, so its own Durable Object namespace and its own Container application;
* its own migration tag (`v1-staging-indexer-container`), so it cannot touch the
  production script's migration history;
* `max_instances = 1`, `instance_type = "standard-1"` (0.5 vCPU, 4 GiB, 8 GB ephemeral disk);
* the same private R2 bucket `company-intel-data`, because the benchmark must read the real
  sources and write a real index;
* `STAGING_MODE = "true"` and `ACTIVE_MANIFEST_KEY = "staging/active.json"`.

### What staging structurally cannot do

| Must not | How it is prevented | Where |
| --- | --- | --- |
| Publish the final application | it is a different Worker with a `-staging` hostname and its own assets; nothing promotes it | `wrangler.staging.toml` |
| Overwrite the active search index | the pointer it reads/writes is `staging/active.json`; production reads `manifests/active.json` | `ACTIVE_MANIFEST_KEY` → `worker/src/store.ts`, `worker/src/app.ts`, `worker/src/indexer-admin.ts` |
| Overwrite any production index object | every staging version id must start with `stg-`, so all generated keys are `indexes/stg-…`, `companies/stg-…`, `manifests/stg-…`; the API returns 400 otherwise | `stagingVersionError()` in `worker/src/indexer-admin.ts` |
| Start the 64 GB job | a start without a byte bound is refused with `staging_bounded_only` (403) | same file |
| List or control production jobs | `/api/cloud/jobs` filters to `stg-…` when `STAGING_MODE` is on | same file |
| Change original files under `raw/` | the container only ever issues ranged GETs; no code path writes `raw/` | `tools/cloud/pass1.ts`, `worker/src/indexer-admin.ts` |
| Expose private data publicly | every `/api` route verifies a Cloudflare Access JWT server-side and fails closed; cross-origin requests are rejected; the bucket has no public access and no `r2.dev` URL | `worker/src/access.ts`, `worker/src/app.ts` |
| Run without authorisation | the admin surface additionally checks `INDEXING_ADMIN_EMAILS`; the container has no inbound route | `worker/src/indexer-admin.ts`, `worker/src/indexer-container.ts` |

Staging shares the bucket deliberately: an isolated bucket would not benchmark the real
sources or produce a real index, and a copy of 64 GB would cost more than the benchmark.
Sharing is safe because every write is under a `stg-` version and the pointer is separate.

### A defect these tests found (fixed)

Writing the isolation tests exposed a real production defect: `indexingAdmin` registered
its routes as `/jobs`, `/preflight`, … while the Worker entrypoint dispatches the full path
`/api/cloud/…`. Every deployed admin request would have answered **404** — the preview only
worked because the dev server serves those routes itself. The router is now mounted with
`basePath("/api/cloud")`, and `tests/staging-isolation.test.ts` drives the routes with their
real URLs so it cannot regress silently. These tests also caught that a staging deployment
answered `503` (no container bound) before it answered `403` (policy refusal) for a
full-corpus start; policy checks now run first.

## 3. Getting this exact code onto GitHub (the one real blocker)

`git` and GitHub commands are refused in this environment, and there is no push
credential. The workspace is therefore the authoritative copy, and one of these three
routes moves it:

1. **Vly's own source-control publish**, if it is enabled for this project — it is the
   preferred route because it preserves the whole tree without a local Git client.
2. **Upload the archive this repository generates** (this is the route that needs no
   tooling on your side):

   ```
   bun scripts/source-archive.mjs
   ```

   Verified output from this workspace: `index-reports/companyintel-source-<date>.tar.gz`,
   **310 entries, 0.92 MB**, sha256 printed by the script, containing `tools/cloud`,
   `tools/indexer`, `cloud/`, `worker/`, `src/`, `tests/`, `docs/`, `scripts/`,
   `package.json`, `bun.lock`, `Dockerfile`, `wrangler.toml`, `wrangler.staging.toml`.
   It excludes `node_modules`, `dist`, `.git`, indexing spools/outputs, `index-reports`,
   raw samples, logs, and any `.env*` / `.r2-credentials*.json`. The working tree is not
   modified and nothing is deleted. Restore it anywhere with
   `tar -xzf companyintel-source-<date>.tar.gz`.

3. **A single `git` push from any machine that has the repository checked out**, if the
   archive route is inconvenient.

Do not assume the repository already contains this work: it was developed in this
workspace and has not been pushed. Commit it on a branch (for example
`staging-cloud-indexer`) so no unrelated branch work is overwritten, and open a PR; the
Cloudflare build should run against the merged result, not against a loose branch.

## 4. Cloudflare Workers Builds configuration

Workers Builds is Git-connected CI/CD that builds and deploys **inside Cloudflare**, which
is what removes the Docker requirement from your machine. Verified against Cloudflare's
current documentation:

* Dockerfile builds **can run in the Workers Builds environment** — you do not need Docker
  locally to build or deploy the container image.
* `wrangler deploy` builds and pushes the container image and starts the container
  rollout. **`wrangler versions upload` does not**: it uploads Worker code only and never
  publishes an image or rolls out container instances. Any "preview" command must not be
  relied on to deploy a changed container.
* Build environment: 4 vCPU, 8 GB memory, 20 GB disk; 20-minute timeout; 6,000 build
  minutes/month on the Workers Paid plan.
* Rollout flags: `--containers-rollout=immediate` replaces instances immediately;
  `--containers-rollout=none` deploys Worker code only and skips the image build. A
  successful deploy means **the rollout started**, not that every instance is replaced.

### Settings for the staging project

In **Workers & Pages → companyintel-staging → Settings → Build** (create the project by
connecting the repository first, then choosing the Worker name):

| Field | Value |
| --- | --- |
| Root directory | `/` (the repository root) |
| Build command | `bun install --frozen-lockfile && bun run verify && bun run build` |
| Deploy command | `bunx wrangler deploy -c wrangler.staging.toml` |
| Non-production deploy command | leave empty / `bunx wrangler versions upload` (it will not deploy containers — that is expected) |
| Production branch | `main` (or the branch the PR merged into) |
| API token | created by Cloudflare for Workers Builds (§5) |

Verification that runs in the build itself: `bun run verify` = four typechecks + ESLint +
the full suite (613 tests, including the staging-isolation and secret-placement guards).
It fails the build rather than deploying a broken Worker, and it never touches production
resources. `wrangler deploy` only runs after it passes, so a failed build cannot alter the
production Worker.

`bun run verify` runs the typechecks, the linter and the full test suite, then `bun run
build` produces `dist/` which the Worker serves through the `ASSETS` binding. If the whole
command approaches the 20-minute build timeout, move the tests into a separate CI job and
keep `bun install --frozen-lockfile && bun run build` as the build command — do not shorten
the test suite.

### Settings for the production project

Keep production deploys deliberate: point the production-build branch at a release branch
(or use a manual deploy) rather than `main`, so nothing reaches the public application
without a decision. The deploy command is `bunx wrangler deploy`. Cloudflare's build system
reads the Wrangler version from `package.json`; `wrangler@4.151.2` is now pinned there, so
Builds and local runs agree.

**If Workers Builds cannot be enabled for this account** (for example, if the Containers
preview is not available for the repository or the platform rejects the container build),
the fallback is the same CI on another cloud builder with Docker, running the same three
commands: install, build, `wrangler deploy -c wrangler.staging.toml` with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets. No personal machine is
required for either route.

## 5. Credentials, least privilege

Never paste a token into chat, source, or a tracked file.

**Deployment (build/deploy time), if you create the token yourself** — Cloudflare
dashboard → **My Profile → API Tokens → Create Token → Custom token**:

| Permission (as shown in the dashboard) | Scope | Why |
| --- | --- | --- |
| Workers Scripts: Edit (or the `Editor` role on the individual Worker) | the account, or the one Worker | upload the Worker and its assets |
| Containers: Edit | the account | build/push the image and roll the container out |
| Workers KV: Edit | account | only if a KV binding existed (this project has none) |
| Workers R2 Storage: Edit | account | **not required** for deploying a Worker with an R2 binding; needed only if CI itself reads/writes bucket objects |
| Zone → Workers Routes: Edit | only the zone you attach a route to | only if the deployment changes a route or custom domain |

Workers Builds creates and manages its own token with these permissions when you connect
the repository, which is the simplest option and keeps the credential out of your hands.
Cloudflare Access **service tokens** authenticate a client to an Access-protected app; they
are not Wrangler credentials and cannot deploy.

**Runtime container credentials (`R2_*`), set as Worker secrets, never in a file:**

| Secret | Value | Scope |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | your account id | — |
| `R2_ACCESS_KEY_ID` | R2 token access key | **Object Read & Write**, scoped to `company-intel-data` only |
| `R2_SECRET_ACCESS_KEY` | R2 token secret | same |

These are forwarded into the container at start time by `worker/src/indexer-container.ts`
and are never returned to a browser, logged, or written to R2. They are the only reason the
typed `R2_*` names exist in the Worker — `tests/worker-r2-binding.test.ts` asserts they
appear in no other Worker file. The Worker itself reads R2 through the `COMPANY_DATA`
binding and needs no keys.

Commands (run once per Worker; paste the value at the hidden prompt):

```
bunx wrangler secret put CF_ACCESS_TEAM_DOMAIN -c wrangler.staging.toml
bunx wrangler secret put CF_ACCESS_AUD         -c wrangler.staging.toml
bunx wrangler secret put ALLOWED_EMAILS        -c wrangler.staging.toml
bunx wrangler secret put INDEXING_ADMIN_EMAILS -c wrangler.staging.toml
bunx wrangler secret put R2_ACCOUNT_ID         -c wrangler.staging.toml
bunx wrangler secret put R2_ACCESS_KEY_ID      -c wrangler.staging.toml
bunx wrangler secret put R2_SECRET_ACCESS_KEY  -c wrangler.staging.toml
```

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` come from a **Cloudflare Access application
that covers the staging hostname** — create it before the first request, the API fails
closed until it exists.

Verify the bindings without ever printing a value:

```
bunx wrangler secret list -c wrangler.staging.toml   # names and types only, never values
bunx wrangler secret list                            # the production Worker
```

Locally (no credentials needed), `tests/staging-config.test.ts` asserts that neither Wrangler
config contains a secret name or value, that only variable *names* are declared, and that the
budget is wired through one variable. `tests/worker-r2-binding.test.ts` asserts the `R2_*`
names appear only in the container bridge, exactly once each.

## 6. The controlled benchmark

### Configuration (frozen, so the approval is for a real number)

| Setting | Value |
| --- | --- |
| Job version | `stg-bench-2026-10-19` (any `stg-…` id; changing it creates a new isolated version) |
| Sources | both real objects: `raw/file1.csv`, `raw/file2.csv` |
| Sample | **96 MiB per source** (0.15% of the corpus), read in ranged requests only |
| Partitions | 32 (Pass 1 and Pass 2 must agree; the full run uses 256) |
| Container | **1 instance, `standard-1`: 0.5 vCPU, 4 GiB RAM, 8 GB ephemeral disk**, `max_instances = 1` |
| Worker | 1 script, 1 Durable Object namespace, 1 container application, no route, `workers_dev` staging hostname behind Access |
| Build machine | 4 vCPU, 8 GB RAM, 20 GB disk, 20-minute timeout (Cloudflare's Workers Builds paid limits) |
| Combined job budget | `CLOUD_JOB_BUDGET_USD = 5` on the staging Worker (a stop, not a cap) |
| Expected container runtime | ~3–10 minutes (Pass 1 parse + Pass 2 merge + validation) |
| Expected R2 operations | ~1,000–6,000 Class A, ~1,000–6,000 Class B |
| Expected incremental cost | **$0.00–$0.10**; the container time is inside the Workers Paid Containers allowance (375 vCPU-min, 25 GiB-h, 200 GB-h/month). This is an estimate from the bounded measurements in `docs/cloud.md`, not a bill, and the real R2 invoice may post later. |

Nothing about this benchmark can start by itself: it needs an approved `/indexing` action
or an authenticated `POST /api/cloud/…` call.

### What it measures, and where each number comes from

| Wanted | Source |
| --- | --- |
| Container runtime | `state.json` timestamps + the container's own log lines (`bunx wrangler tail companyintel-staging`) |
| CPU / memory | container logs and the Cloudflare dashboard's container metrics for the instance |
| Peak temporary disk | the driver reports peak scratch use; partition scratch is one partition at a time |
| Pass 1 throughput | `state.json.rate.rowsPerSecond`, plus `totals.sourceBytesRead` over elapsed time |
| Pass 2 throughput | `state.json.pass2.rowsPerSecond` and `pass2.partitionsDone` |
| R2 object count and size | `state.json.totals.segments` / `segmentBytes`, `pass2.indexObjects` / `indexBytes`, `shardParts` |
| R2 read/write operations | `state.json.accounting.classA` / `classB` / `bytesRead` / `bytesWritten` |
| Index completeness | `POST /api/cloud/jobs/<version>/verify` (segment verification) and the Pass 2 validation report in `manifests/stg-…/validation.json` |
| Search compatibility | query the built version through the staging Worker's `/companies` (its pointer is `staging/active.json`) |
| Checkpoint/restart behaviour | `cloud/jobs/<version>/pass2/checkpoint.json` plus a deliberate pause/resume **of the benchmark only** |
| Incremental cost | `state.json.accounting.estimatedUsd` + `containerUsd` (combined), compared with the forecast in `docs/cloud.md` |
| Peak shard-write memory | `bun scripts/benchmark-shard-memory.mjs` (measured in this workspace, §7) |

### Approval requested before it runs

* maximum configured allocation: as in the table above (1 × `standard-1` container, 32
  partitions, 96 MiB per source);
* estimated expense: **under $5**, realistically **$0.00–$0.10**;
* explicit approval needed: setting the `R2_*` secrets, allowing the staging deploy, and
  starting the bounded benchmark. The full corpus is **not** part of this approval.

### Cleanup (optional, later)

Staging writes only: `cloud/jobs/stg-*`, `indexes/stg-*`, `companies/stg-*`, `contacts/stg-*`,
`details/stg-*`, `unassigned/stg-*`, `manifests/stg-*`, `staging/active.json`. Deleting those
prefixes removes every trace; **do not** delete anything without that `stg-` prefix.

## 7. Pass 2 memory: measured, with the arithmetic

Pass 2's one unbounded-in-principle step used to be serialising a shard: `JSON.stringify`
built the whole document as one string and `gzipSync` then held the payload plus two copies
of it. That is now streamed (`shardJsonParts` → incremental gzip), the bytes are identical
(a test asserts it), and each term's arrays are released as they are written.

Measured in this workspace with `bun scripts/benchmark-shard-memory.mjs` (peak RSS sampled
every 2 ms):

```
postings      old peak   old object    new peak   new object
   500,000     41.3 MB      1.1 MB     10.7 MB      1.1 MB
 2,000,000     62.4 MB      4.3 MB     29.0 MB      4.3 MB
 8,000,000    329.2 MB     17.3 MB    300.0 MB     17.3 MB
```

Worst-case arithmetic for the real corpus (this is the bound that matters, not the
benchmark's row count):

* ~99 M contacts, ~3–6 postings per name → ~300–600 M postings across **256 token shards**
  ⇒ ~1.2–2.3 M postings per shard on average;
* a very common single term (a common first name) is the largest single term; at 4 M
  postings the projected peak is ~180 MB;
* a shard holding several common terms is still bounded by the shard's total postings;
  even ten times the average (≈ 23 M postings) projects to ~1 GB, which fits the 4 GiB
  instance with the merge's own per-partition state;
* the run is linear in the payload, so the guard is arithmetic: the container fails only if
  a shard approaches ~30 M postings, which the 256-shard layout does not produce.

Decision: the current `standard-1` (4 GiB) instance is sufficient, and
`bun scripts/benchmark-shard-memory.mjs` can be re-run after the benchmark with the real
shard sizes to re-check.

## 8. Pass 2 interruption and cost control

* **Durable batch checkpoints.** `cloud/jobs/<version>/pass2/checkpoint.json` is written
  after every merged partition and again when the merge finishes. The merge-complete
  checkpoint stores everything the finalize phase needs (counters, stats, partition
  indices, the generated-object list).
* **Finalize-phase resume.** A restart after the merge is complete verifies that every
  posting-shard object it names is still in R2 (count and total bytes) and then rebuilds
  only the index shards, manifests and validation — the merge is not repeated.
* **Merge-phase replay (explicit limitation).** Document refs are assigned sequentially
  across partitions, so a restart *during* the merge still replays from partition 1; a
  partial replay would produce a different index. The replay is deterministic and
  overwrites identical bytes. The checkpoint makes the cost visible and bounds the loss to
  the finalize tail.
* **One combined budget.** `CLOUD_JOB_BUDGET_USD` (30 production, 5 staging) covers the
  whole job: Pass 1 checks it at each chunk boundary, Pass 2 at each partition boundary,
  using R2 requests + measured container seconds together. `CLOUD_BUDGET_USD` is still
  accepted as a deprecated alias so an existing deployment does not silently lose its
  guard. Benchmarks are never stopped by it.
* **Honest caveat.** This is a guard, not a billing cap: storage, and any request
  Cloudflare bills after the snapshot, are excluded, and Cloudflare's budget alert is a
  notification only. Pause and abort remain authoritative, and both are one click in
  `/indexing`.

## 9. What is not verified (what stays unknown until it runs)

* nobody has deployed to Cloudflare from this workspace; there is no API token here, and
  the deployment was validated only as a dry run;
* the container image has never been built (no Docker here) — Workers Builds is the first
  environment that will build it;
* every number in §6 is an estimate from bounded runs; the benchmark exists to replace it
  with a measurement;
* Cloudflare Access was not exercised against a real deployment;
* the full 64.26 GB corpus is untouched, no index was re-pointed, and nothing was deleted.

## 10. Actions required from you

1. **Repository (GitHub → `acharya7/companyintel-pro`)**: publish this workspace. Either let
   Vly publish the source, or run `bun scripts/source-archive.mjs` here, download the
   archive, and commit its contents on a branch such as `staging-cloud-indexer`. The
   repository does not currently contain the cloud indexing work.
2. **Cloudflare dashboard → Workers & Pages → Create → Workers → connect the repository**:
   name it `companyintel-staging`; set root directory `/`, build command
   `bun install --frozen-lockfile && bun run verify && bun run build`, deploy command
   `bunx wrangler deploy -c wrangler.staging.toml`, production branch = your merge branch.
3. **Cloudflare dashboard → Zero Trust → Access → Applications → Add self-hosted
   application**: cover `companyintel-staging.<your-subdomain>.workers.dev`, one `Allow`
   policy for your email, no bypass; then run the two `CF_ACCESS_*` secret commands in §5.
4. **Cloudflare dashboard → R2 → Manage API Tokens** (or **R2 → company-intel-data**): create
   an **Object Read & Write** token scoped to `company-intel-data` only, then run the three
   `R2_*` secret commands in §5.
5. **Approve the bounded benchmark** described in §6: 1 × `standard-1` container, 32
   partitions, 96 MiB per source, combined budget $5, expected cost under $0.10. Say
   "approved" and I will start it through the control plane; the 64 GB job is a separate,
   later decision.

Nothing else is needed from your machine: no Docker, no PowerShell sequence, no local
indexing.
