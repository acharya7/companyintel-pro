/**
 * Dev-only control plane for cloud indexing.
 *
 * The panel must not display invented job state, so every read here comes from
 * the same `cloud/jobs/<version>/state.json` object a container writes, and every
 * control is the same `control.json` flag the engine checks between chunks. The
 * handlers only translate HTTP to the CLI; no indexing logic is duplicated.
 *
 * This bridge cannot start a full run: `run` requires an explicit `maxSourceMb`, so
 * the browser can launch a bounded benchmark but never the 64 GB job, which needs
 * operator approval recorded in `control.json`. The deployed Worker does expose the
 * one-click full-corpus launch (`/api/cloud/swarm/*` + the approval route), but that
 * runs on Durable Objects and Containers, which a Vite dev server has no binding
 * for — `/api/cloud/swarm/*` therefore answers 503 here with that reason instead of
 * a bare 404 that would look like a missing route.
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
 * Server-side authorisation for the control plane.
 *
 * The dev server is not a public deployment, but the controls are still gated by a
 * server-held token rather than the presence of a route: set `CLOUD_ADMIN_TOKEN`
 * and the browser must send the same value in `x-companyintel-cloud-admin`. The
 * default only exists so `bun run dev` works locally; it is never used by the
 * deployed Worker, which exposes no cloud-admin route at all.
 */
function authorised(request) {
  const expected = process.env.CLOUD_ADMIN_TOKEN || "dev";
  return request.headers["x-companyintel-cloud-admin"] === expected;
}

/**
 * Handle `/api/cloud/…`. Returns true when the request was handled.
 */
export async function handleCloudAdmin(request, response, root = process.cwd()) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/cloud/")) return false;

  // A custom header means a cross-site form POST cannot reach these controls; the
  // value must match CLOUD_ADMIN_TOKEN when one is configured.
  if (!authorised(request)) {
    json(response, 403, { error: { code: "admin_auth_required", message: "Missing or invalid x-companyintel-cloud-admin token." } });
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

    if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "pass2" && method === "POST") {
      const body = await readBody(request);
      if (body.confirm !== "PASS2") {
        json(response, 400, { error: { code: "confirmation_required", message: "Send confirm: \"PASS2\"." } });
        return true;
      }
      const version = parts[1];
      const { state, control } = cliJson(root, ["status", "--version", version, "--json"]);
      if (!state) {
        json(response, 404, { error: { code: "no_such_job", message: `No cloud job ${version}.` } });
        return true;
      }
      if (state.mode === "full" && !control?.approvedFullRun) {
        json(response, 403, {
          error: { code: "approval_required", message: "A full-corpus Pass 2 requires control.approvedFullRun." },
        });
        return true;
      }
      if (!["pass1-complete", "pass2", "paused"].includes(state.stage)) {
        json(response, 409, {
          error: { code: "wrong_stage", message: `Pass 2 needs pass1-complete; the job is ${state.stage}.` },
        });
        return true;
      }
      const partitions = Number(body.partitions ?? state.partitions ?? 256);
      if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
        json(response, 400, { error: { code: "invalid_partitions", message: "partitions must be 1..256." } });
        return true;
      }
      const pid = startDetached(root, [
        "pass2",
        "--version",
        version,
        "--partitions",
        String(partitions),
        "--work-dir",
        resolve(root, `.indexer-cloud-pass2-${version}`),
      ]);
      json(response, 202, { started: true, version, partitions, pid });
      return true;
    }

    if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "activate" && method === "POST") {
      const body = await readBody(request);
      const version = parts[1];
      if (body.confirm !== version) {
        json(response, 400, { error: { code: "confirmation_required", message: `Send confirm: \"${version}\".` } });
        return true;
      }
      const { state } = cliJson(root, ["status", "--version", version, "--json"]);
      if (!state) {
        json(response, 404, { error: { code: "no_such_job", message: `No cloud job ${version}.` } });
        return true;
      }
      // Bounded benchmarks are never activatable, and an unfinished version has no
      // uploaded manifest to verify. `publish` re-checks both against R2.
      if (state.mode !== "full") {
        json(response, 409, { error: { code: "not_activatable", message: "A bounded benchmark can never be activated." } });
        return true;
      }
      if (state.stage !== "complete") {
        json(response, 409, { error: { code: "wrong_stage", message: `Version is ${state.stage}, not complete.` } });
        return true;
      }
      const output = spawnSync("bun", ["tools/indexer/src/cli.ts", "publish", "--version", version, "--yes"], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      json(response, output.status === 0 ? 200 : 422, {
        ok: output.status === 0,
        output: `${output.stdout ?? ""}${output.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n"),
      });
      return true;
    }

    if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "start" && method === "POST") {
      const body = await readBody(request);
      if (body.confirm !== "START" || body.stage !== "pass1") {
        json(response, 400, {
          error: { code: "invalid_request", message: 'Full Pass 1 needs confirm: "START" and stage: "pass1".' },
        });
        return true;
      }
      const version = parts[1];
      if (!/^[a-z0-9][a-z0-9._-]{2,60}$/i.test(version)) {
        json(response, 400, { error: { code: "invalid_version", message: "Invalid version id." } });
        return true;
      }
      // The approval flag is the gate. The CLI re-checks it and refuses without it,
      // so a stale panel cannot start the corpus by itself.
      const { control } = cliJson(root, ["status", "--version", version, "--json"]);
      if (!control?.approvedFullRun) {
        json(response, 403, {
          error: { code: "approval_required", message: `control.json for ${version} does not record approvedFullRun.` },
        });
        return true;
      }
      const pid = startDetached(root, ["run", "--version", version, "--approve-full"]);
      json(response, 202, { started: true, version, stage: "pass1", pid });
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

    if (parts[0] === "swarm") {
      json(response, 503, {
        error: {
          code: "swarm_requires_deployment",
          message:
            "The 16-container swarm needs the deployed Worker: its Durable Object coordinator and Container bindings do not exist in the local dev server. Open /indexing on the deployed Worker to start it.",
        },
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
