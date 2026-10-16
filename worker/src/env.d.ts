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
}

export interface AccessIdentity {
  email: string;
  /** Verified JWT subject. */
  sub: string;
  /** `dev` when the explicit local-development bypass is enabled. */
  source: "access" | "dev";
}
