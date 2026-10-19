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
  /** Forwarded to the container; Pass 1 pauses when its running estimate reaches it. */
  CLOUD_BUDGET_USD?: string;
}

export interface AccessIdentity {
  email: string;
  /** Verified JWT subject. */
  sub: string;
  /** `dev` when the explicit local-development bypass is enabled. */
  source: "access" | "dev";
}
