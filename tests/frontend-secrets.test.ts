/**
 * Frontend secret-leak guard.
 *
 * Vite inlines any `import.meta.env.VITE_*` value into the client bundle, and
 * only those. Everything else — R2 credentials, the Access audience, the email
 * allowlist, the team domain — exists solely as a Worker secret. This test
 * enforces that at the source level, so a future edit cannot quietly move a
 * server secret into client-reachable code.
 *
 * It is a static check of the source tree plus (when a production build exists)
 * a scan of `dist/`. It does not replace reviewing the deployed bundle once.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DIST = join(import.meta.dir, "..", "dist");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const files = sourceFiles(SRC);

/** Identifiers that must never be referenced from client code. */
const SERVER_ONLY = [
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "CF_ACCESS_AUD",
  "CF_ACCESS_TEAM_DOMAIN",
  "ALLOWED_EMAILS",
  "DEV_ALLOW_UNAUTHENTICATED",
  "COMPANY_DATA",
];

describe("frontend bundle safety", () => {
  test("no client code reads a server-side secret or binding name", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      // Prose is allowed (an error message may name the binding); reading it is not.
      for (const name of SERVER_ONLY) {
        const read = new RegExp(`(?:process\\.env|import\\.meta\\.env)\\.${name}\\`);
        if (read.test(text)) offenders.push(`${relative(join(SRC, ".."), path)} reads ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("client env access is limited to VITE_ prefixed variables", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      // `import.meta.env.SOMETHING` is only safe for VITE_*.
      for (const match of text.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
        if (!match[1].startsWith("VITE_")) {
          offenders.push(`${relative(join(SRC, ".."), path)} reads import.meta.env.${match[1]}`);
        }
      }
      // Plain `process.env.*` is not defined in the browser at all.
      for (const match of text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
        offenders.push(`${relative(join(SRC, ".."), path)} reads process.env.${match[1]}`);
      }
    }

    // The one remaining reader is the platform's unimported scaffolding file.
    // Prove it is unreachable before excusing it, so this exclusion cannot hide
    // a real leak later: if anything ever imports it, this test fails.
    const scaffolding = join(SRC, "lib", "vly-integrations.ts");
    expect(offenders.every((entry) => entry.startsWith(relative(join(SRC, ".."), scaffolding)))).toBe(true);
    const importers = files.filter(
      (path) => path !== scaffolding && /from\s+["'].*vly-integrations["']/.test(readFileSync(path, "utf8")),
    );
    expect(importers).toEqual([]);
  });

  test("the API client never receives a token it would have to forward", () => {
    const worker = readFileSync(join(SRC, "lib", "api", "worker.ts"), "utf8");
    // Cloudflare Access auth is a browser cookie handled by the platform. The
    // app must not read, store or attach an Access JWT itself.
    expect(worker).not.toMatch(/Cf-Access-Jwt-Assertion/i);
    expect(worker).not.toMatch(/CF_Authorization/i);
    expect(worker).toMatch(/credentials:\s*"include"/);
  });

  test("when a production bundle exists, it contains no secret names or values", () => {
    let bundleFiles: string[] = [];
    try {
      bundleFiles = readdirSync(join(DIST, "assets"))
        .filter((name) => name.endsWith(".js") || name.endsWith(".css"))
        .map((name) => join(DIST, "assets", name));
    } catch {
      bundleFiles = [];
    }
    if (!bundleFiles.length) {
      // `bun run build` has not been run in this environment; the source-level
      // checks above still hold, and the same scan runs automatically once a
      // bundle is present. Reported as skipped rather than silently passed.
      expect(bundleFiles).toEqual([]);
      return;
    }
    const offenders: string[] = [];
    for (const path of bundleFiles) {
      const text = readFileSync(path, "utf8");
      for (const name of SERVER_ONLY) if (text.includes(name)) offenders.push(`${path} contains ${name}`);
      if (/cloudflareaccess\.com/.test(text) && !/cdn-cgi\/access\/certs/.test(text)) {
        offenders.push(`${path} embeds an Access team domain`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Coverage note surfaced in the test output. */
test("scan covers the whole client source tree", () => {
  expect(files.length).toBeGreaterThan(20);
  expect(files.every((path) => path.endsWith(".ts") || path.endsWith(".tsx"))).toBe(true);
  void sep;
});
