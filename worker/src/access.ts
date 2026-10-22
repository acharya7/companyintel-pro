/**
 * Cloudflare Access verification.
 *
 * The application is single-user and private. Cloudflare Access sits in front of
 * BOTH the frontend and the API, but a header check is not authentication: an
 * attacker who can reach the Worker directly (`*.workers.dev`, a preview URL, an
 * alternate route) could otherwise add `Cf-Access-Jwt-Assertion` themselves.
 *
 * This module therefore performs the full verification Cloudflare documents:
 *   1. extract the JWT from the `Cf-Access-Jwt-Assertion` header or the
 *      `CF_Authorization` cookie,
 *   2. fetch the team's JWKS from `<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
 *   3. verify the RS256 signature with WebCrypto against the matching `kid`,
 *   4. verify `iss` (exact team issuer), `aud` (this Access application),
 *      `exp`/`nbf`/`iat` with a small clock skew allowance,
 *   5. enforce the single-identity email allowlist (case-insensitive).
 *
 * The signature/claim logic lives in a pure function so the security tests can
 * exercise it with a locally generated RSA key pair.
 */

import type { AccessIdentity, Env } from "./env";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: Jwk[];
}

export interface AccessClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
  type?: string;
  /** Present on service-token assertions instead of `email`. */
  common_name?: string;
}

export class AccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: "unauthorized" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/* ------------------------------- helpers --------------------------------- */

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const bytes = base64UrlToBytes(part);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function extractToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header.trim();
  const cookie = request.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "CF_Authorization") return rest.join("=");
    }
  }
  return null;
}

/** Access tokens carry no issuer when the team domain is unknown — never guess. */
export function issuerFor(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return /^https?:\/\//.test(teamDomain) ? teamDomain.replace(/\/$/, "") : `https://${host}`;
}

export function jwksUrlFor(teamDomain: string): string {
  return `${issuerFor(teamDomain)}/cdn-cgi/access/certs`;
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/* --------------------------- signature + claims -------------------------- */

export interface VerifyOptions {
  token: string;
  jwks: JwksResponse;
  audience: string;
  issuer: string;
  allowedEmails: string[];
  /** Injectable clock for tests. */
  now?: number;
  /** Injectable verifier so tests can run without WebCrypto RSA import quirks. */
  verifySignature?: (payload: string, signature: Uint8Array, jwk: Jwk) => Promise<boolean>;
  /** Require the `email` claim (Access service tokens do not have one). */
  requireEmail?: boolean;
}

const ALGORITHMS = ["RS256"];

export async function verifySignatureWithJwk(
  signingInput: string,
  signature: Uint8Array,
  jwk: Jwk,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n ?? "", e: jwk.e ?? "", alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signingInput));
}

/** Verify one Access JWT. Throws `AccessError` on any failure. */
export async function verifyAccessToken(options: VerifyOptions): Promise<AccessClaims> {
  const parts = options.token.split(".");
  if (parts.length !== 3) throw new AccessError(401, "unauthorized", "Malformed Access token");

  const header = decodeJsonPart(parts[0]) as { alg?: string; kid?: string; typ?: string };
  if (!header.alg || !ALGORITHMS.includes(header.alg)) {
    throw new AccessError(401, "unauthorized", `Unsupported Access token algorithm: ${header.alg ?? "none"}`);
  }

  const jwk = options.jwks.keys.find((candidate) => (header.kid ? candidate.kid === header.kid : true));
  if (!jwk) throw new AccessError(401, "unauthorized", "Access token key id does not match the team JWKS");

  const signature = base64UrlToBytes(parts[2]);
  const verify = options.verifySignature ?? verifySignatureWithJwk;
  const valid = await verify(`${parts[0]}.${parts[1]}`, signature, jwk);
  if (!valid) throw new AccessError(401, "unauthorized", "Access token signature verification failed");

  const claims = decodeJsonPart(parts[1]) as unknown as AccessClaims;
  const now = Math.floor((options.now ?? Date.now()) / 1000);

  if (claims.iss !== options.issuer) {
    throw new AccessError(401, "unauthorized", "Access token issuer does not match the configured team domain");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new AccessError(401, "unauthorized", "Access token audience does not match this application");
  }

  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new AccessError(401, "unauthorized", "Access token is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new AccessError(401, "unauthorized", "Access token is not valid yet");
  }

  if (options.requireEmail !== false) {
    if (!claims.email) throw new AccessError(401, "unauthorized", "Access token has no email claim");
    const email = claims.email.toLowerCase();
    if (options.allowedEmails.length && !options.allowedEmails.includes(email)) {
      throw new AccessError(403, "forbidden", `Identity ${email} is not on the allowlist for this application`);
    }
  }

  return claims;
}

/* ------------------------------ JWKS caching ----------------------------- */

type JwksCache = { jwks: JwksResponse; fetchedAt: number };
const jwksCache = new Map<string, JwksCache>();

export async function loadJwks(teamDomain: string, force = false): Promise<JwksResponse> {
  const url = jwksUrlFor(teamDomain);
  const cached = jwksCache.get(url);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.jwks;
  const response = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!response.ok) {
    throw new AccessError(500 as number, "unauthorized", `Unable to fetch Access public keys (${response.status})`);
  }
  const jwks = (await response.json()) as JwksResponse;
  jwksCache.set(url, { jwks, fetchedAt: Date.now() });
  return jwks;
}

/** Test seam: drop cached keys. */
export function resetJwksCache(): void {
  jwksCache.clear();
}

/* ------------------------------ entry point ------------------------------ */

/**
 * Verify the caller of an API request.
 *
 * Local development requires an EXPLICIT opt-in (`DEV_ALLOW_UNAUTHENTICATED`)
 * and is refused whenever `ENVIRONMENT === "production"`, so production
 * authorization can never be weakened by a leftover local setting.
 */
export async function verifyAccess(request: Request, env: Env): Promise<AccessIdentity> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  const allowedEmails = parseAllowlist(env.ALLOWED_EMAILS);

  const devBypass = env.DEV_ALLOW_UNAUTHENTICATED === "true" && env.ENVIRONMENT !== "production";
  if (devBypass && !teamDomain) {
    return { email: "dev@localhost", sub: "dev", source: "dev" };
  }

  if (!teamDomain || !audience) {
    throw new AccessError(
      500 as number,
      "unauthorized",
      "Cloudflare Access is not configured for this deployment (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD missing). Refusing to serve private data.",
    );
  }
  if (!allowedEmails.length) {
    throw new AccessError(
      500 as number,
      "unauthorized",
      "ALLOWED_EMAILS is empty. Set the single approved identity before serving private data.",
    );
  }

  const token = extractToken(request);
  if (!token) {
    throw new AccessError(401, "unauthorized", "Missing Cloudflare Access token");
  }

  let jwks = await loadJwks(teamDomain);
  try {
    const claims = await verifyAccessToken({ token, jwks, audience, issuer: issuerFor(teamDomain), allowedEmails });
    return { email: (claims.email ?? "").toLowerCase(), sub: claims.sub ?? "unknown", source: "access" };
  } catch (error) {
    // A rotated signing key produces `kid` mismatches: refresh once, then fail.
    if (error instanceof AccessError && error.message.includes("key id")) {
      jwks = await loadJwks(teamDomain, true);
      const claims = await verifyAccessToken({ token, jwks, audience, issuer: issuerFor(teamDomain), allowedEmails });
      return { email: (claims.email ?? "").toLowerCase(), sub: claims.sub ?? "unknown", source: "access" };
    }
    // Access SERVICE TOKENS are issued to an application, not a person, so they carry
    // no `email` claim (type "app"). They are still fully signature/issuer/audience
    // verified above and can only be minted by an Access policy that lists them, so
    // they authenticate as `service-token:<common_name>` — never as a person.
    if (error instanceof AccessError && error.message.includes("no email claim")) {
      const claims = await verifyAccessToken({
        token,
        jwks,
        audience,
        issuer: issuerFor(teamDomain),
        allowedEmails,
        requireEmail: false,
      });
      if (claims.type !== "app") throw error;
      const name = (claims as AccessClaims & { common_name?: string }).common_name?.trim() || "unnamed";
      return { email: `service-token:${name}`.toLowerCase(), sub: claims.sub ?? name, source: "access" };
    }
    throw error;
  }
}
