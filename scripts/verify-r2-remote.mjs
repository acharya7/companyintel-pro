#!/usr/bin/env node
/**
 * One-command, read-only verification of the real R2 bucket.
 *
 *   bun run verify:r2:remote                       # human-readable report
 *   bun run verify:r2:remote --json > raw-verification.json
 *   bun run verify:r2:remote --keys raw/a.csv,raw/b.csv
 *   bun run verify:r2:remote --max 40 --read-bytes 4096 --sample-bytes 8388608
 *
 * What it does:
 *   1. starts the isolated probe Worker with `wrangler dev` — bound to
 *      127.0.0.1, using the remote `COMPANY_DATA` R2 binding, so your existing
 *      Wrangler login is the only credential involved (no S3 keys at all);
 *   2. waits for the probe's /health endpoint;
 *   3. reads /report: a bounded `raw/` listing, both source objects with real
 *      sizes/ETags, a bounded body read per source, the published-dataset state,
 *      and a schema report per source (encoding, delimiter, headers, fill rates,
 *      mapping suggestions) with no cell values in it;
 *   4. shuts the probe down again and returns a meaningful exit status.
 *
 * Exit codes: 0 = verified, 1 = a problem was reported (missing/unreadable/not
 * published), 2 = the probe could not be started or did not answer.
 *
 * The probe is never deployed and nothing is ever written to the bucket: the
 * Worker it starts has no write code path at all.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { exitCodeFor, renderProbeReport } from "./lib/probe-report.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const asJson = Boolean(flag("json"));
const keepOpen = Boolean(flag("keep-open"));
const port = positiveInt(flag("port", process.env.PROBE_PORT), 8788);
const startTimeoutSeconds = positiveInt(flag("timeout"), 120);
const externalUrl = typeof flag("url") === "string" ? String(flag("url")) : null;
const baseUrl = (externalUrl ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
const configPath = "probe/wrangler.toml";

const query = new URLSearchParams();
if (typeof flag("keys") === "string") query.set("keys", String(flag("keys")));
if (flag("max") !== undefined) query.set("max", String(positiveInt(flag("max"), 25)));
if (flag("read-bytes") !== undefined) query.set("readBytes", String(positiveInt(flag("read-bytes"), 1024)));
if (flag("sample-bytes") !== undefined) query.set("sampleBytes", String(positiveInt(flag("sample-bytes"), 6 * 1024 * 1024)));
if (flag("rows") !== undefined) query.set("rows", String(positiveInt(flag("rows"), 500)));
if (typeof flag("prefix") === "string") query.set("prefix", String(flag("prefix")));

/**
 * Progress notes. In `--json` mode they go to stderr so stdout stays a single
 * parseable JSON document, which is what makes
 * `bun run verify:r2:remote --json > raw-verification.json` safe to pipe.
 */
function note(line) {
  if (asJson) console.error(line);
  else console.log(line);
}

const logTail = [];
function remember(chunk) {
  for (const line of String(chunk).split("\n")) {
    if (!line.trim()) continue;
    logTail.push(line);
    if (logTail.length > 40) logTail.shift();
  }
}

function fail(message, hint, code = 2) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: message, hint: hint ?? null }, null, 2));
  } else {
    console.error(`\n${message}`);
    if (hint) console.error(`\n${hint}`);
  }
  if (logTail.length) {
    console.error("\n--- wrangler output (last lines) ---");
    for (const line of logTail) console.error(line);
  }
  process.exit(code);
}

/** Start `wrangler dev` for the probe config. Never deploys, never uses --local. */
function startProbe() {
  const localWrangler = resolve(root, "node_modules/.bin/wrangler");
  const command = existsSync(localWrangler) ? localWrangler : "bunx";
  // `--ip 127.0.0.1` keeps the probe off every other interface. `--local` is
  // deliberately absent: it would disable the remote binding and simulate an
  // empty bucket. The interactive dev session is disabled because a script has no
  // terminal for it.
  const devArgs = [
    "dev",
    "--config",
    configPath,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "warn",
    "--show-interactive-dev-session=false",
  ];
  const args = existsSync(localWrangler) ? devArgs : ["wrangler", ...devArgs];

  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env },
  });
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.on("error", (error) => remember(`spawn error: ${error.message}`));
  return child;
}

/** Stop the probe and everything it started. Bounded, never hangs the script. */
async function stopProbe(child) {
  if (!child || child.exitCode !== null) return;
  const signalTree = (signal) => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };

  await new Promise((resolveExit) => {
    const done = () => resolveExit();
    child.once("exit", done);
    signalTree("SIGINT");
    setTimeout(() => {
      if (child.exitCode === null) signalTree("SIGKILL");
    }, 4000).unref?.();
    setTimeout(done, 8000).unref?.();
  });
}

async function waitForHealth(child) {
  const deadline = Date.now() + startTimeoutSeconds * 1000;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      fail(
        `The probe exited before it answered (exit code ${child.exitCode}).`,
        [
          "Most common causes:",
          "  • Wrangler is not authenticated — run `bunx wrangler login` once and retry.",
          "  • Wrangler is older than the remote-binding syntax — `bunx wrangler --version` should be 4.x.",
          "  • Port " + port + " is already in use — retry with `--port 8789`.",
          "Nothing was written to the bucket.",
        ].join("\n"),
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail(`The probe did not become ready within ${startTimeoutSeconds}s (${lastError}).`, "Re-run with a longer timeout (`--timeout 300`) or check the wrangler output below.");
}

async function main() {
  if (externalUrl) {
    note(`Using the probe already running at ${baseUrl} (no new probe started).`);
  } else {
    if (!existsSync(resolve(root, configPath))) {
      fail(`Probe configuration not found at ${configPath}.`);
    }
    note(`Starting the read-only probe: wrangler dev --config ${configPath} --ip 127.0.0.1 --port ${port}`);
  }

  const child = externalUrl ? null : startProbe();
  const onSignal = () => {
    void stopProbe(child).then(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (child) await waitForHealth(child);
    else await waitForHealth({ exitCode: null });

    const url = `${baseUrl}/report${query.toString() ? `?${query}` : ""}`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body means the probe itself failed before answering.
    }

    if (!response.ok || !payload || payload.error) {
      const message = payload?.error?.message ?? text.slice(0, 400);
      const hint =
        payload?.error?.code === "refused_production"
          ? "The probe refused to run against a production environment. Start it with this script (it uses probe/wrangler.toml)."
          : payload?.error?.hint ?? "Nothing was written to the bucket. Check the wrangler output below and re-run.";
      fail(`The probe returned HTTP ${response.status}: ${message}`, hint);
    }

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n${renderProbeReport(payload)}\n`);
    }

    const code = exitCodeFor(payload);
    if (keepOpen && child) {
      note(`Probe left running at ${baseUrl} (pid ${child.pid}). Stop it with Ctrl-C when finished.`);
      return;
    }
    await stopProbe(child);
    note(child ? "Probe stopped; nothing was written to the bucket." : "Nothing was written to the bucket (this run used an already-running probe).");
    process.exit(code);
  } finally {
    if (!keepOpen) await stopProbe(child);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
