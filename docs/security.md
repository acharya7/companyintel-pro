# Security

Single user, no internal accounts. Access is granted by Cloudflare Access and verified
server-side on every API request. There is no registration, login, guest mode, billing or
password storage anywhere in this application.

## Threat model

| Asset | Risk | Control |
| --- | --- | --- |
| Company/contact data (R2) | public exposure | private bucket, no `r2.dev` domain, no public bucket access, Worker-only access through the `COMPANY_DATA` binding |
| API | anonymous or cross-origin access | Cloudflare Access JWT verification on every `/api/*` route, same-origin enforcement |
| Lead notes / saved searches | unauthorized modification | same Access verification; writes are ETag-conditional |
| S3 credentials | leakage | never in the repository or the browser; the local indexer reads environment variables, and the deployed Worker holds them as secrets solely to forward to the indexing container |
| Indexing control plane | unauthorized runs, cost | Cloudflare Access on every `/api/cloud/*` route, a separate `INDEXING_ADMIN_EMAILS` allowlist, same-origin enforcement, and an explicit approval flag for the full corpus |
| Alternate hostnames | bypassing the policy | every deployed hostname (workers.dev, preview, custom domain) must be covered by an Access policy — see below |

## Access verification (`worker/src/access.ts`)

For every `/api/*` request the Worker:

1. reads the token from the `Cf-Access-Jwt-Assertion` header **or** the `CF_Authorization`
   cookie;
2. fetches the team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) and
   verifies the **RS256 signature** against the matching `kid`;
3. verifies `iss` (team domain), `aud` (the Access application's AUD tag), `exp`/`nbf` with
   clock-skew tolerance, and rejects `alg: none` and otherwise malformed tokens;
4. checks identity: the `email` claim must be in `ALLOWED_EMAILS`, or a service token's
   `common_name` must be allowlisted for machine access;
5. rejects anything unverified with `401`/`403`.

**Fail closed.** In production, if `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is unset, or the
allowlist is empty, the Worker returns `503` and serves nothing — it never falls back to
"no auth configured, allow everything". `DEV_ALLOW_UNAUTHENTICATED` is ignored unless
`ENVIRONMENT !== "production"`, and the bypass additionally requires the Access team domain to
be absent, so a stale development flag cannot weaken production.

`tests/security-access.test.ts` covers all of this with real signatures: correct token, tampered
payload, expired, not-yet-valid, wrong audience, wrong issuer, unknown key, `none` algorithm,
non-allowlisted identity, service token, malformed token, anonymous production request,
unconfigured Access, empty allowlist, the dev bypass refusing to engage in production, and a
bare `Cf-Access-*` header that is *not* a valid token (a header alone must never impersonate the
owner). `bun test` runs them.

## Indexing control plane (`worker/src/indexer-admin.ts`)

- Every route verifies Access itself (`verifyAccess`) before reading the job state, and
  rejects cross-origin requests. The `/api/cloud/*` path being obscure is not a control.
- `INDEXING_ADMIN_EMAILS` narrows the operators further; if unset, the Access allowlist is
  used.
- A full-corpus run requires `approvedFullRun` written to `control.json`. A browser cannot
  set that flag by starting a run: only the explicit `approve` action writes it.
- Activation is refused for benchmark jobs and for any stage other than `complete`, then
  re-verifies the manifest and validation report **in R2** before flipping the pointer.
- The Worker never returns an R2 key or a container environment variable. The container
  receives its S3 credentials from Worker secrets at start time; they are never logged.
- R2 secrets must be scoped to Object Read & Write on `company-intel-data` only.

## Other controls

- **Cross-origin**: `/api/*` rejects any request whose `Origin` differs from the Worker's own
  origin (`403`). No permissive CORS headers are emitted.
- **Security headers** on every response: `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, `x-frame-options: DENY`,
  `permissions-policy: geolocation=(), microphone=(), camera=()`,
  `cross-origin-opener-policy: same-origin`.
- **Input validation**: every request body/query is parsed with a Zod schema
  (`src/shared/api-contract.ts`) and rejected with `400` plus a readable message.
- **Bounded work**: `pageSize ≤ 100`, `resultBudget ≤ 2000`, `MAX_EXPORT_ROWS = 50_000`,
  at most 50 company partitions per contact listing. No endpoint can be asked to scan the
  dataset or the raw CSVs.
- **Rate limiting**: per-identity, per-route (default 180 requests/minute in production,
  configurable via `MAX_SEARCHES_PER_MINUTE`). The in-isolate limiter is best-effort by nature;
  add a Cloudflare WAF rate-limiting rule on `/api/*` for a hard guarantee.
- **Errors**: responses contain a code, a message and a request id — never stack traces, SQL/R2
  keys, secrets or tokens. The request id appears in both the response and the logs.
- **Caching**: only immutable, version-addressed index objects may be edge-cached. Leads,
  settings, saved searches and exports are never cached in a shared cache, and Access runs
  *before* any cache lookup, so a cache hit can never bypass authorization.
- **Browser storage**: IndexedDB entries are version-scoped, bounded and TTL'd, and contact
  payloads are redacted by default so sensitive contact data is not retained indefinitely.
- **Exports**: CSV generation escapes formula-leading values (`=`, `+`, `-`, `@`, tab, CR) to
  prevent spreadsheet injection, and only fields present in the data are exported.
- **Logging**: no contact payloads, tokens or query strings that contain personal data are
  logged.

## Deployment checklist (do all of these)

1. `wrangler.toml` keeps the R2 bucket private; do not enable the `r2.dev` public URL.
2. Create the Access application for **every** hostname you deploy to, including
   `*.workers.dev`, and give each one an `Allow` policy for your email. No `Bypass` policy.
3. `workers_dev = false` is already set for production in `wrangler.toml` (only `env.development`
   keeps the alias), so the `*.workers.dev` hostname does not exist. Add your custom-domain
   `[routes]` entry at deploy time.
4. Set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ALLOWED_EMAILS` as Worker secrets
   (never in `wrangler.toml`, never in chat).
5. Verify from a terminal outside Access: `curl -i https://<host>/api/health` must return
   `401`/`403`, never `200`.
6. Confirm `/api/dataset/status` from a signed-in browser returns real manifest data.
7. Add a WAF rate-limiting rule for `/api/*` if you want a hard cap beyond the in-isolate
   limiter.
8. Rotate R2 S3 credentials if they were ever exposed; the Worker does not use them at all.
9. Create the Access application for the **staging** Worker hostname too, before its first
   request, and set its `CF_ACCESS_*` secrets. Staging shares the R2 bucket and can read the
   real sources, so it must be behind the same outer gate as production.
10. Deploy the container to the staging Worker first (`wrangler.staging.toml`) and keep
    production's `ACTIVE_MANIFEST_KEY` unset. Staging isolation — separate pointer, `stg-`
    version prefix, no full-corpus starts, own DO namespace and container app — is listed in
    `docs/staging.md` §2, and each rule is asserted in the Worker rather than documented only.
11. Keep the deployment credential and the `R2_*` runtime credential separate: the
    deployment token needs Workers Scripts + Containers, while `R2_*` should be an
    **Object Read & Write** token scoped to `company-intel-data` alone (`docs/staging.md` §5).

## Residual risks (stated honestly)

- The in-isolate rate limiter resets when isolates recycle; use WAF for a strict limit.
- R2 has no transactions: concurrent writes to the same lead partition are detected via ETag
  preconditions and surfaced as a conflict, not silently merged (see `docs/recovery.md`).
- A compromised Access session cookie is a compromised session — enable short session
  durations and MFA on your identity provider.
