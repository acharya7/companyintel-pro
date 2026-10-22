#!/usr/bin/env node
/**
 * Cloudflare Container entrypoint for CompanyIntel indexing.
 *
 * The container is a job runner, not a service: a Worker/Durable Object starts
 * it with a job specification, this process executes the CLI, and progress is
 * written to R2 (`cloud/jobs/<version>/state.json`) after every chunk. If the
 * container is stopped (SIGTERM, host event, deploy), the durable checkpoint is
 * what the next start resumes from — never this process's memory.
 *
 * Routes
 *   GET  /health          readiness for the orchestrator, including the resolved root
 *   POST /job             { "args": ["run", "--version", "v1", "--approve-full"] }
 *                         streams JSON lines until the command exits
 *
 * Project root
 *   The image copies the repository into `/app` (see Dockerfile) and this file
 *   lives at `/app/cloud/runner.mjs`, so the root is the PARENT of this file's
 *   directory: `/app`. The previous version used this file's own directory
 *   (`/app/cloud`) and spawned `bun tools/cloud/cli.ts` inside it, which resolved
 *   to `/app/cloud/tools/cloud/cli.ts` — a path that does not exist. Bun exited
 *   immediately with "Could not find module", the runner still answered 202, and
 *   nothing was ever written to R2. The root is now derived from the file URL and
 *   the CLI depends on it, not on the process working directory.
 *
 * Failure reporting
 *   A detached start answers 202 only when the child is still running after a
 *   short settle window. If it exits or cannot be spawned inside that window the
 *   response is an error carrying the exit code and the tail of its stderr, so a
 *   broken start is never reported as success.
 *
 * Security: the container has no inbound public route. Cloudflare forwards only
 * from the Worker/DO that owns the job; R2 credentials come from the container's
 * secret environment, never from a request body.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `/app/cloud/runner.mjs` → `/app` (the image WORKDIR, where tools/ lives). */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute CLI path: never resolved against a caller-supplied cwd. */
const cliPath = join(root, "tools", "cloud", "cli.ts");
const port = Number(process.env.PORT ?? 8080);
/** The Bun that runs this file; the CLI is TypeScript, so never fall back to node. */
const bunBin = process.versions?.bun ? process.execPath : (process.env.BUN_BIN ?? "bun");
/** How long a detached start must survive before it is reported as started. */
const START_SETTLE_MS = Number(process.env.JOB_START_SETTLE_MS ?? 1500);
/** How long a child gets to stop at a chunk boundary after SIGTERM. */
const CHILD_GRACE_MS = Number(process.env.JOB_STOP_GRACE_MS ?? 90_000);
/** How long the `interrupt` bookkeeping command may take while shutting down. */
const RECORD_TIMEOUT_MS = Number(process.env.JOB_RECORD_TIMEOUT_MS ?? 15_000);
const STDERR_TAIL_BYTES = 4096;

const ALLOWED_COMMANDS = new Set([
  "preflight",
  "run",
  "benchmark",
  "pass2",
  "status",
  "jobs",
  "verify",
  "pause",
  "resume",
  "abort",
  "interrupt",
  // Bounded direct R2 search (REAL DATA level 3). The command is resumable and
  // writes the same `cloud/jobs/<id>/` heartbeat the keep-alive alarm inspects.
  "scan",
  // Swarm tasks. These process ONE block or ONE byte range of one source, so a
  // container's whole job is a few minutes of work that the coordinator leases out;
  // they never touch the single-job state (`/task` below, not `/job`).
  "blocks",
  "range",
]);

/** The CLI is present only when the image was copied correctly. */
function cliPresent() {
  try {
    return statSync(cliPath).isFile();
  } catch {
    return false;
  }
}

/** In-flight or last finished detached job, for readiness/diagnostics. */
let active = null;
let lastJob = null;
/** In-flight or last finished SWARM task (`/task`), kept apart from the single job. */
let taskActive = null;
let taskLast = null;
/** True while a detached start is inside its settle window (before `active` exists). */
let starting = false;
/** Set by the first stop signal; a second one exits immediately. */
let shuttingDown = false;

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/**
 * Spawn the CLI and mirror its output into the container log.
 *
 * The tail of stderr is kept so a start that fails inside the settle window can
 * be answered with the real reason instead of a bare 202.
 */
function spawnCli(args) {
  const child = spawn(bunBin, [cliPath, ...args], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = { text: "" };
  const keep = (chunk) => {
    tail.text = `${tail.text}${String(chunk)}`;
    if (tail.text.length > STDERR_TAIL_BYTES) tail.text = tail.text.slice(-STDERR_TAIL_BYTES);
  };
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => {
    keep(chunk);
    process.stderr.write(chunk);
  });
  return { child, tail };
}

function settle({ child, tail }) {
  return new Promise((settleResolve) => {
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      settleResolve(outcome);
    };
    const onError = (error) => finish({ kind: "spawn-error", message: error.message, stderr: tail.text });
    const onExit = (code, signal) => finish({ kind: "exited", code, signal, stderr: tail.text });
    const timer = setTimeout(() => finish({ kind: "running" }), START_SETTLE_MS);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/**
 * The job id from the CLI arguments, so a stop can be recorded against its job.
 * `--version` is the one argument every run/benchmark/pass2 command carries.
 */
function versionFromArgs(args) {
  const index = args.indexOf("--version");
  const value = index === -1 ? null : args[index + 1];
  return typeof value === "string" && value && !value.startsWith("--") ? value : null;
}

/**
 * Ask the CLI to record a stop in R2 (`run.json` + job state).
 *
 * This is the only writer that can describe a death the child did not survive, and
 * it is idempotent: if the CLI already recorded a terminal outcome, a second call
 * only fills in the process details. It runs while the container is still alive, so
 * it must be bounded — a hung record must not delay shutdown past the platform's
 * SIGKILL.
 */
function recordInterruption(args, details = {}) {
  const version = versionFromArgs(args);
  if (!version || !cliPresent()) return Promise.resolve(false);
  const argv = [cliPath, "interrupt", "--version", version, "--reason", details.reason ?? "the run stopped"];
  argv.push("--outcome", details.outcome ?? "interrupted");
  if (details.exitCode !== null && details.exitCode !== undefined) argv.push("--exit-code", String(details.exitCode));
  if (details.signal) argv.push("--signal", String(details.signal));
  if (details.detail) argv.push("--detail", String(details.detail).slice(-800));
  const stage = args[0] === "pass2" ? "pass2" : "pass1";
  argv.push("--stage", stage);
  return new Promise((done) => {
    const child = spawn(bunBin, argv, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.error("[job] the interruption record did not finish in time");
      done(false);
    }, RECORD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      console.error(`[job] could not record the interruption: ${error.message}`);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** Resolve true when the child exited, false when the grace period ran out. */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

function track({ child, tail }, args) {
  const startedAt = new Date().toISOString();
  const finish = (code, signal) => {
    if (active?.pid !== (child.pid ?? null)) return;
    const endedAt = new Date().toISOString();
    active = null;
    lastJob = { args, startedAt, endedAt, exitCode: code, signal, running: false, stderr: tail.text.slice(-1000) };
    console.log(`[job] exited code ${code ?? "null"} signal ${signal ?? "none"} after ${args.join(" ")}`);
    if (code !== 0 || signal) {
      const reason = tail.text.trim().split("\n").slice(-5).join(" | ");
      console.error(`[job] last stderr: ${reason || "(no stderr)"}`);
      // The CLI records its own failures; this covers a crash or a SIGKILL, where it
      // could not. Idempotent, so a duplicate is harmless.
      void recordInterruption(args, {
        reason: signal
          ? `the indexing process was terminated by ${signal}`
          : `the indexing process exited with code ${code ?? "null"} before finishing`,
        outcome: signal ? "terminated" : "failed",
        exitCode: code,
        signal,
        detail: tail.text.slice(-600),
      });
    }
  };
  active = { pid: child.pid ?? null, args, startedAt, child, running: true };
  // The settle window resolves on the same event this listener would wait for, so a
  // fast exit can have happened already; `exitCode` is then non-null and no later
  // event will fire.
  if (child.exitCode !== null || child.signalCode !== null) return finish(child.exitCode, child.signalCode);
  child.once("exit", finish);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  if (url.pathname === "/health") {
    const present = cliPresent();
    // A container without its CLI is running but not usable. Answering 503 here
    // lets the Durable Object report the exact reason instead of a bare 502.
    // `job.running` is what the Durable Object's keep-alive alarm reads: it must be
    // present while a detached child is alive, not merely while a request is open.
    const job = active
      ? { pid: active.pid, args: active.args, startedAt: active.startedAt, running: true }
      : lastJob
        ? { args: lastJob.args, startedAt: lastJob.startedAt, endedAt: lastJob.endedAt, exitCode: lastJob.exitCode, signal: lastJob.signal, running: false }
        : null;
    return json(response, present ? 200 : 503, {
      ok: present,
      root,
      cli: cliPath,
      cliPresent: present,
      pid: process.pid,
      job,
      ...(present ? {} : { error: `The indexing CLI is missing at ${cliPath}. The image must copy tools/ into ${root}.` }),
    });
  }

  if (url.pathname === "/job" && request.method === "POST") {
    let body;
    try {
      body = await readBody(request);
    } catch {
      return json(response, 400, { error: "invalid JSON body" });
    }
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    if (!ALLOWED_COMMANDS.has(args[0])) {
      return json(response, 400, { error: `args[0] must be one of ${[...ALLOWED_COMMANDS].join(", ")}` });
    }
    if (!cliPresent()) {
      // Checked before spawning: the image is broken, not the job.
      return json(response, 503, {
        error: { code: "cli_missing", message: `The indexing CLI is missing at ${cliPath} (root ${root}).` },
        root,
        cli: cliPath,
      });
    }
    if (active || starting) {
      const runningJob = active ?? { pid: null, args: ["(starting)"] };
      return json(response, 409, {
        error: {
          code: "job_already_running",
          message: `A job is already running (pid ${runningJob.pid}, ${runningJob.args.join(" ")}). Pause or abort it before starting another.`,
        },
        job: runningJob,
      });
    }

    const running = spawnCli(args);

    /*
     * Detached mode: the Worker's admin route starts a job that may run for hours,
     * far longer than one HTTP request. It asks for an immediate 202 and follows the
     * job through `cloud/jobs/<version>/state.json` in R2, which the CLI writes after
     * every chunk or partition. The child keeps running inside the container; a
     * container stop is safe because the checkpoint is durable.
     *
     * 202 means "still running after the settle window", not "the spawn returned".
     */
    if (body.detach === true) {
      starting = true;
      let outcome;
      try {
        outcome = await settle(running);
      } finally {
        starting = false;
      }
      if (outcome.kind === "running") {
        track(running, args);
        return json(response, 202, { started: true, pid: running.child.pid ?? null, root, cli: cliPath, args });
      }
      if (outcome.kind === "exited" && outcome.code === 0) {
        return json(response, 200, {
          started: false,
          completed: true,
          exitCode: 0,
          args,
          output: `The command completed before it could be detached (exit 0).`,
        });
      }
      const detail = outcome.kind === "spawn-error" ? outcome.message : `exit code ${outcome.code ?? "null"}`;
      const stderr = (outcome.stderr ?? "").trim().slice(-1000);
      console.error(`[job] failed to start (${detail}) for: ${args.join(" ")}`);
      if (stderr) console.error(`[job] stderr: ${stderr}`);
      return json(response, 500, {
        error: {
          code: "job_failed_to_start",
          message: `The indexing command ${args.join(" ")} failed to start: ${detail}.`,
          detail: stderr || undefined,
        },
        root,
        cli: cliPath,
        args,
      });
    }

    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const forward = (chunk) => response.write(chunk);
    running.child.stdout.on("data", forward);
    running.child.stderr.on("data", forward);
    running.child.on("close", (code) => {
      response.write(`${JSON.stringify({ event: "exit", code })}\n`);
      response.end();
    });
    // Cloudflare stops an instance with SIGTERM and gives it 15 minutes; the global
    // handler below forwards the signal so the CLI exits at a chunk boundary instead
    // of being killed mid-write.
    return;
  }

  /*
   * Swarm task routes.
   *
   * A swarm worker asks for one block scan or one byte range at a time. These are
   * kept apart from `/job` on purpose: `/job` owns the single-container job record
   * (state.json, run.json, the keep-alive alarm), and a range task must not be able
   * to relabel the whole job as failed. The runner only reports process facts here —
   * rows and checksums are read from R2 by the Durable Object that owns the task.
   */
  if (url.pathname === "/task" && request.method === "POST") {
    let body;
    try {
      body = await readBody(request);
    } catch {
      return json(response, 400, { error: "invalid JSON body" });
    }
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    if (!ALLOWED_COMMANDS.has(args[0])) {
      return json(response, 400, { error: `args[0] must be one of ${[...ALLOWED_COMMANDS].join(", ")}` });
    }
    if (!cliPresent()) {
      return json(response, 503, {
        error: { code: "cli_missing", message: `The indexing CLI is missing at ${cliPath} (root ${root}).` },
        root,
        cli: cliPath,
      });
    }
    if (active || starting || taskActive) {
      return json(response, 409, {
        error: { code: "task_already_running", message: "This container is already running a task." },
        task: taskActive ?? { args: ["(starting)"] },
      });
    }

    const running = spawnCli(args);
    starting = true;
    let outcome;
    try {
      outcome = await settle(running);
    } finally {
      starting = false;
    }
    if (outcome.kind === "running") {
      const task = { pid: running.child.pid ?? null, args, startedAt: new Date().toISOString(), running: true, exitCode: null, signal: null, stderr: "" };
      taskActive = task;
      running.child.once("exit", (code, signal) => {
        taskActive = null;
        taskLast = { ...task, running: false, exitCode: code, signal, stderr: running.tail.text.slice(-1500) };
        console.log(`[task] exited code ${code ?? "null"} signal ${signal ?? "none"} after ${args.slice(0, 3).join(" ")}`);
      });
      return json(response, 202, { started: true, pid: task.pid, args, root });
    }
    if (outcome.kind === "exited" && outcome.code === 0) {
      taskLast = { pid: running.child.pid ?? null, args, startedAt: new Date().toISOString(), running: false, exitCode: 0, signal: null, stderr: outcome.stderr ?? "" };
      return json(response, 200, { started: false, completed: true, exitCode: 0, args });
    }
    const detail = outcome.kind === "spawn-error" ? outcome.message : `exit code ${outcome.code ?? "null"}`;
    const stderr = (outcome.stderr ?? "").trim().slice(-1000);
    taskLast = { pid: null, args, startedAt: new Date().toISOString(), running: false, exitCode: outcome.code ?? null, signal: outcome.signal ?? null, stderr };
    return json(response, 500, {
      error: { code: "task_failed_to_start", message: `The task ${args.join(" ")} failed to start: ${detail}.`, detail: stderr || undefined },
      args,
    });
  }

  if (url.pathname === "/task" && request.method === "GET") {
    return json(response, 200, { task: taskActive ?? taskLast });
  }

  json(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`companyintel cloud indexer listening on :${port}`);
  console.log(`  root ${root}`);
  console.log(`  cli  ${cliPath} (${cliPresent() ? "present" : "MISSING"})`);
  if (!cliPresent()) {
    console.error(`[startup] the indexing CLI is missing at ${cliPath}; /health will report 503 until the image is rebuilt.`);
  }
});

server.on("error", (error) => {
  console.error(`[startup] the container HTTP server could not listen on :${port}: ${error.message}`);
  process.exit(1);
});

/**
 * Platform stop: forward SIGTERM, wait for a clean exit, then record it.
 *
 * Cloudflare stops a container with SIGTERM to its main process (this file) and then
 * SIGKILLs whatever is left after the grace period. A detached CLI is a grandchild
 * that never sees that signal on its own, so the runner must forward it, give the
 * CLI time to finish the chunk it is on, and — because the CLI may be killed before
 * it can write anything — record the interruption in R2 itself.
 *
 * This is the fix for the staging job that stopped after one checkpoint: nothing
 * observed the stop, so `state.json` kept saying `stage: pass1` with no reason.
 */
async function shutdown(signal) {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; stopping the runner`);
  server.close();
  const job = active;
  if (job?.child) {
    job.child.kill("SIGTERM");
    const exited = await waitForExit(job.child, CHILD_GRACE_MS);
    if (!exited) {
      job.child.kill("SIGKILL");
      await recordInterruption(job.args, {
        reason: `the container was stopped (${signal}) before the job could finish; it did not exit within ${Math.round(CHILD_GRACE_MS / 1000)}s`,
        outcome: "terminated",
        signal,
      });
    } else {
      // The CLI normally records its own interruption; this covers the case where it
      // was killed inside a write and could not.
      await recordInterruption(job.args, {
        reason: `the container was stopped (${signal}); the job exited at its last committed chunk`,
        outcome: "interrupted",
        signal,
      });
    }
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => void shutdown(signal));
}
