/**
 * Security tests for Cloudflare Access verification.
 *
 * These tests generate a real RSA key pair with Node's crypto module, sign real
 * RS256 JWTs and run them through the same verification code the Worker uses, so
 * the checks are exercised end to end rather than asserted against a mock.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  AccessError,
  extractToken,
  issuerFor,
  jwksUrlFor,
  parseAllowlist,
  verifyAccess,
  verifyAccessToken,
  type AccessClaims,
} from "../worker/src/access";
import type { Env } from "../worker/src/env";

const TEAM = "companyintel.cloudflareaccess.com";
const AUD = "aud-tag-123";
const EMAIL = "owner@example.com";

let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
let jwks: { keys: { kid: string; kty: string; n: string; e: string; alg: string }[] };

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signToken(claims: Partial<AccessClaims> & { exp: number }, header: Record<string, unknown> = {}): string {
  const fullClaims: AccessClaims = {
    iss: `https://${TEAM}`,
    aud: AUD,
    iat: Math.floor(Date.now() / 1000) - 5,
    email: EMAIL,
    sub: "user-1",
    ...claims,
  };
  const head = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT", ...header }));
  const body = base64Url(JSON.stringify(fullClaims));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${base64Url(signature)}`;
}

beforeAll(() => {
  const { privateKey: priv, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = priv;
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };
  jwks = { keys: [{ kid: "test-key", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }] };
});

/** Built per call so it always sees the key pair generated in `beforeAll`. */
const base = () => ({
  jwks,
  audience: AUD,
  issuer: `https://${TEAM}`,
  allowedEmails: [EMAIL],
});

describe("access helpers", () => {
  test("issuer and JWKS URLs are derived from the team domain", () => {
    expect(issuerFor("companyintel.cloudflareaccess.com")).toBe("https://companyintel.cloudflareaccess.com");
    expect(issuerFor("https://companyintel.cloudflareaccess.com/")).toBe("https://companyintel.cloudflareaccess.com");
    expect(jwksUrlFor(TEAM)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  test("allowlist parsing is case-insensitive and trimmed", () => {
    expect(parseAllowlist(" Owner@Example.com , second@example.com ")).toEqual(["owner@example.com", "second@example.com"]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  test("tokens are read from the header or the CF_Authorization cookie", () => {
    expect(extractToken(new Request("https://app.example/api/health", { headers: { "cf-access-jwt-assertion": "abc" } }))).toBe("abc");
    expect(extractToken(new Request("https://app.example/api/health", { headers: { cookie: "theme=dark; CF_Authorization=xyz; other=1" } }))).toBe("xyz");
    expect(extractToken(new Request("https://app.example/api/health"))).toBeNull();
  });
});

describe("JWT verification", () => {
  test("accepts a correctly signed token for the allowlisted identity", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300 });
    const claims = await verifyAccessToken({ token, ...base() });
    expect(claims.email).toBe(EMAIL);
  });

  test("rejects a token with a tampered payload", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300 });
    const [head, , signature] = token.split(".");
    const forged = base64Url(JSON.stringify({ iss: base.issuer, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300, email: "attacker@example.com" }));
    await expect(verifyAccessToken({ token: `${head}.${forged}.${signature}`, ...base() })).rejects.toThrow(/signature/i);
  });

  test("rejects an expired token", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/expired/i);
  });

  test("rejects a token that is not valid yet", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) + 600 });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/not valid yet/i);
  });

  test("rejects the wrong audience", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300, aud: "some-other-app" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/audience/i);
  });

  test("rejects the wrong issuer", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300, iss: "https://attacker.cloudflareaccess.com" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/issuer/i);
  });

  test("rejects an unknown signing key", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300 }, { kid: "rotated-away" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/key id/i);
  });

  test("rejects the `none` algorithm", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300 }, { alg: "none" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/algorithm/i);
  });

  test("rejects a well-signed token for an identity that is not allowlisted", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300, email: "someone-else@example.com" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/allowlist/i);
  });

  test("rejects a service token without an allowlisted common name", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) + 300, email: undefined, sub: "", common_name: "ci.access" });
    await expect(verifyAccessToken({ token, ...base() })).rejects.toThrow(/email claim/i);
  });

  test("rejects a malformed token", async () => {
    await expect(verifyAccessToken({ token: "not-a-jwt", ...base() })).rejects.toThrow(/Malformed/i);
  });
});

describe("request-level verification", () => {
  const env = {
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    ALLOWED_EMAILS: EMAIL,
    ENVIRONMENT: "production",
  } as unknown as Env;

  test("production rejects anonymous requests", async () => {
    await expect(verifyAccess(new Request("https://app.example/api/companies/search"), env)).rejects.toBeInstanceOf(AccessError);
  });

  test("production refuses to serve when Access is unconfigured", async () => {
    const unconfigured = { ENVIRONMENT: "production" } as unknown as Env;
    await expect(verifyAccess(new Request("https://app.example/api/health"), unconfigured)).rejects.toThrow(/not configured/i);
  });

  test("production refuses to serve with an empty allowlist", async () => {
    const noAllowlist = { ...env, ALLOWED_EMAILS: "" } as unknown as Env;
    await expect(verifyAccess(new Request("https://app.example/api/health"), noAllowlist)).rejects.toThrow(/ALLOWED_EMAILS/i);
  });

  test("the development bypass can never engage in production", async () => {
    const sneaky = { ...env, DEV_ALLOW_UNAUTHENTICATED: "true", ENVIRONMENT: "production" } as unknown as Env;
    await expect(verifyAccess(new Request("https://app.example/api/health"), sneaky)).rejects.toBeInstanceOf(AccessError);
  });

  test("the development bypass works locally only without a team domain", async () => {
    const dev = { DEV_ALLOW_UNAUTHENTICATED: "true", ENVIRONMENT: "development" } as unknown as Env;
    const identity = await verifyAccess(new Request("http://127.0.0.1:8787/api/health"), dev);
    expect(identity.source).toBe("dev");
  });

  test("an unverified header alone cannot impersonate the owner", async () => {
    const request = new Request("https://app.example/api/companies/search", {
      headers: { "cf-access-jwt-assertion": "forged-but-plausible", "cf-access-authenticated-user-email": EMAIL },
    });
    await expect(verifyAccess(request, env)).rejects.toBeInstanceOf(AccessError);
  });
});
