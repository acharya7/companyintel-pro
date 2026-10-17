/**
 * Types for the development API Vite plugin (`vite-plugin.mjs`).
 *
 * The plugin itself stays a `.mjs` file so it can never be bundled into a
 * production build, but `vite.config.ts` imports it and the config is
 * type-checked — so the surface it uses is declared here rather than left
 * implicitly `any`.
 */

import type { Plugin } from "vite";

/** Options the dev API plugin accepts. */
export interface CompanyIntelDevApiOptions {
  /** Project root the plugin watches for its own source changes. */
  root?: string;
  /** Bucket to read; defaults to `COMPANYINTEL_DEV_BUCKET` or `company-intel-data`. */
  bucket?: string;
  /** Index version to serve, overriding `COMPANYINTEL_DEV_DATASET_VERSION`. */
  version?: string | null;
}

/** Mounts the real Worker API at `/api/*` in `vite dev` (never in a build). */
export function companyIntelDevApi(options?: CompanyIntelDevApiOptions): Plugin;

/** True when a directory looks like a CompanyIntel checkout. */
export function looksLikeCompanyIntel(root: string): boolean;

export const DEV_VERSION_ENV: string;
export const DEV_BUCKET_ENV: string;
