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
 *   GET  /health          readiness for the orchestrator
 *   POST /job             { "args": ["run", "--version", "v1", "--approve-full"] }
 *                         streams JSON lines until the command exits
 *
 * Security: the container has no inbound public route. Cloudflare forwards only
 * from the Worker/DO that owns the job; R2 credentials come from the container's
 * secret environment, never from a request body.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const port = Number(process.env.PORT ?? 8080);

const ALLOWED_COMMANDS = new Set(["preflight", "run", "benchmark", "status", "jobs", "verify", "pause", "resume", "abort"]);

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  if (url.pathname === "/health") return json(response, 200, { ok: true, root });

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
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const child = spawn("bun", ["tools/cloud/cli.ts", ...args], { cwd: root, env: process.env });
    const forward = (chunk) => response.write(chunk);
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("close", (code) => {
      response.write(`${JSON.stringify({ event: "exit", code })}\n`);
      response.end();
    });
    // Cloudflare stops an instance with SIGTERM and gives it 15 minutes. The CLI
    // checkpoints per chunk; the process-level handler below forwards the signal so
    // it exits at a boundary instead of being killed mid-write.
    process.once("SIGTERM", () => child.kill("SIGTERM"));
    return;
  }

  json(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`companyintel cloud indexer listening on :${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not wait forever for an idle keep-alive socket.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
