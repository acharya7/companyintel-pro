/**
 * Dev-only control plane for cloud indexing.
 *
 * The panel must not display invented job state, so every read here comes from
 * the same `cloud/jobs/<version>/state.json` object a container writes, and every
 * control is the same `control.json` flag the engine checks between chunks. The
 * handlers only translate HTTP to the CLI; no indexing logic is duplicated.
 *
 * A full run cannot be started from the panel. `run` requires an explicit
 * `maxSourceMb`, so the browser can launch a bounded benchmark but never the
 * 64 GB job, which needs operator approval recorded in `control.json`.
 */

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = "tools/cloud/cli.ts";

function readBody(request) {
  return new Promise((resolveBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolveBody({});
      }
    });
    request.on("error", () => resolveBody({}));
  });
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

/** Run the CLI synchronously and parse its `--json` line. */
function cliJson(root, args, timeout = 25_000) {
  const result = spawnSync("bun", [CLI, ...args], { cwd: root, encoding: "utf8", timeout });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "cloud CLI failed").trim().split("\n").slice(-3).join(" "));
  }
  const text = (result.stdout ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function startDetached(root, args) {
  const child = spawn("bun", [CLI, ...args], { cwd: root, stdio: "ignore", detached: true, env: process.env });
  child.unref();
  return child.pid;
}

const ACTIONS = new Set(["pause", "resume", "abort"]);

/**
 * Handle `/api/cloud/…`. Returns true when the request was handled.
 */
export async function handleCloudAdmin(request, response, root = process.cwd()) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/cloud/")) return false;

  // A custom header means a cross-site form POST cannot reach these controls.
  if (request.headers["x-companyintel-cloud-admin"] !== "dev") {
    json(response, 403, { error: { code: "admin_header_required", message: "Missing x-companyintel-cloud-admin header." } });
    return true;
  }

  const parts = url.pathname.slice("/api/cloud/".length).split("/").filter(Boolean);
  const method = (request.method ?? "GET").toUpperCase();

  try {
    if (parts[0] === "jobs" && parts.length === 1 && method === "GET") {
      return json(response, 200, cliJson(root, ["jobs", "--json"])), true;
    }

    if (parts[0] === "jobs" && parts[1] === "benchmark" && method === "POST") {
      const body = await readBody(request);
      if (body.confirm !== "BENCHMARK") {
        json(response, 400, { error: { code: "confirmation_required", message: "Send confirm: \"BENCHMARK\"." } });
        return true;
      }
      const version = String(body.version ?? "").trim();
      const maxSourceMb = Number(body.maxSourceMb ?? 16);
      const partitions = Number(body.partitions ?? 16);
      if (!/^[a-z0-9][a-z0-9._-]{2,60}$/i.test(version)) {
        json(response, 400, { error: { code: "invalid_version", message: "A version id is required (letters, digits, . _ -)." } });
        return true;
      }
      if (!Number.isFinite(maxSourceMb) || maxSourceMb <= 0 || maxSourceMb > 256) {
        json(response, 400, { error: { code: "invalid_size", message: "maxSourceMb must be between 1 and 256 for a bounded benchmark." } });
        return true;
      }
      if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
        json(response, 400, { error: { code: "invalid_partitions", message: "partitions must be 1..256." } });
        return true;
      }
      const pid = startDetached(root, [
        "benchmark",
        "--version",
        version,
        "--max-source-mb",
        String(maxSourceMb),
        "--partitions",
        String(partitions),
      ]);
      json(response, 202, { started: true, version, maxSourceMb, partitions, pid });
      return true;
    }

    if (parts[0] === "jobs" && parts[1] === "run" && method === "POST") {
      const body = await readBody(request);
      // Deliberately bounded: the full-corpus run is not reachable from a browser.
      if (body.confirm !== "RUN-BOUNDED") {
        json(response, 400, { error: { code: "confirmation_required", message: "Send confirm: \"RUN-BOUNDED\"." } });
        return true;
      }
      const version = String(body.version ?? "").trim();
      const maxSourceMb = Number(body.maxSourceMb ?? 32);
      if (!/^[a-z0-9][a-z0-9._-]{2,60}$/i.test(version) || !Number.isFinite(maxSourceMb) || maxSourceMb <= 0 || maxSourceMb > 256) {
        json(response, 400, { error: { code: "invalid_request", message: "version and maxSourceMb (1..256) are required." } });
        return true;
      }
      const pid = startDetached(root, ["run", "--version", version, "--max-source-mb", String(maxSourceMb), "--partitions", "16"]);
      json(response, 202, { started: true, version, maxSourceMb, pid });
      return true;
    }

    if (parts[0] === "preflight" && method === "POST") {
      const output = spawnSync("bun", [CLI, "preflight"], { cwd: root, encoding: "utf8", timeout: 30_000 });
      json(response, output.status === 0 ? 200 : 422, {
        ok: output.status === 0,
        output: `${output.stdout ?? ""}${output.stderr ?? ""}`.trim(),
      });
      return true;
    }

    if (parts[0] === "jobs" && parts.length === 2 && method === "GET") {
      return json(response, 200, cliJson(root, ["status", "--version", parts[1], "--json"])), true;
    }

    if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "control" && method === "POST") {
      const body = await readBody(request);
      const action = String(body.action ?? "");
      if (!ACTIONS.has(action)) {
        json(response, 400, { error: { code: "invalid_action", message: "action must be pause, resume or abort." } });
        return true;
      }
      const output = spawnSync("bun", [CLI, action, "--version", parts[1]], { cwd: root, encoding: "utf8", timeout: 25_000 });
      if (output.status !== 0) throw new Error((output.stderr || "control failed").trim());
      json(response, 200, { ok: true, action, version: parts[1], output: (output.stdout ?? "").trim() });
      return true;
    }

    if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "verify" && method === "POST") {
      const output = spawnSync("bun", [CLI, "verify", "--version", parts[1]], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      json(response, output.status === 0 ? 200 : 422, {
        ok: output.status === 0,
        output: `${output.stdout ?? ""}${output.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n"),
      });
      return true;
    }

    json(response, 404, { error: { code: "not_found", message: `No cloud admin route for ${method} ${url.pathname}` } });
    return true;
  } catch (error) {
    json(response, 500, { error: { code: "cloud_admin_failed", message: error?.message ?? String(error) } });
    return true;
  }
}

/** Absolute path to the CLI, for callers that need it. */
export const CLOUD_CLI_PATH = resolve(process.cwd(), CLI);
