/// <reference types="@cloudflare/workers-types" />

/**
 * CompanyIntel Worker environment.
 *
 * Bindings and secrets declared in `wrangler.toml` / `wrangler secret put`:
 *
 *   COMPANY_DATA          R2 bucket binding  → company-intel-data (required)
 *   ASSETS                Static assets binding for the built frontend
 *   ENVIRONMENT           "production" | "preview" | "development"
 *   APP_VERSION           deployed version string
 *   CF_ACCESS_TEAM_DOMAIN e.g. myteam.cloudflareaccess.com      (secret/var)
 *   CF_ACCESS_AUD         Cloudflare Access application AUD tag (secret)
 *   ALLOWED_EMAILS        comma separated single-user allowlist (secret)
 *   DEV_ALLOW_UNAUTHENTICATED  "true" only for local `wrangler dev`
 *   MAX_SEARCHES_PER_MINUTE    per-identity rate limit (default 60)
 *   SEARCH_MAX_HYDRATE         profile partitions read per search (default 16)
 */
export interface Env {
  COMPANY_DATA: R2Bucket;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  APP_VERSION?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  DEV_ALLOW_UNAUTHENTICATED?: string;
  MAX_SEARCHES_PER_MINUTE?: string;
  SEARCH_MAX_HYDRATE?: string;
  /**
   * The mutable dataset pointer this deployment reads and writes.
   *
   * Production leaves it unset (`manifests/active.json`). A staging deployment
   * sets `staging/active.json`, so activating a staging benchmark can never move
   * the production pointer — see `wrangler.staging.toml`.
   */
  ACTIVE_MANIFEST_KEY?: string;
  /**
   * "true" on the staging Worker only. It refuses full-corpus job starts, requires
   * every indexing version id to start with `stg-`, and (with
   * `ACTIVE_MANIFEST_KEY`) keeps activation isolated.
   */
  STAGING_MODE?: string;
  /**
   * Deployment-wide allowlist for the indexing control plane (`/api/cloud/*`). When
   * empty, `ALLOWED_EMAILS` is used, because Access is already the outer gate.
   */
  INDEXING_ADMIN_EMAILS?: string;
  /** Durable Object namespace that owns the indexing container (see wrangler.toml). */
  INDEXER_CONTAINER?: DurableObjectNamespace;
  /**
   * R2 S3 credentials FOR THE CONTAINER ONLY (set with `wrangler secret put`).
   *
   * The Worker itself never uses them: it reads R2 through `COMPANY_DATA`. The
   * container DO forwards them to `container.start({ env })` because the indexing
   * CLI talks to R2 over the S3 API, and Containers have no binding mechanism.
   * A comment in `tests/worker-r2-binding.test.ts` records that exception and
   * asserts these names appear in no other Worker file.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * One budget for the WHOLE indexing job (Pass 1 and Pass 2 together). Forwarded
   * to the container; either stage pauses at its next durable boundary when the
   * combined running estimate reaches it. This is a guard, not a billing cap.
   */
  CLOUD_JOB_BUDGET_USD?: string;
  /**
   * Byte budget per source for ONE direct R2 search scan, in MiB (default 48).
   *
   * A request may ask for less, never more: the Worker clamps to this value before
   * it starts the container, so a query cannot turn into an unrestricted corpus
   * scan. 48 MiB per source is a few seconds of R2 reads and well under a cent.
   */
  REALDATA_SCAN_MAX_MB?: string;
}

export interface AccessIdentity {
  email: string;
  /** Verified JWT subject. */
  sub: string;
  /** `dev` when the explicit local-development bypass is enabled. */
  source: "access" | "dev";
}
