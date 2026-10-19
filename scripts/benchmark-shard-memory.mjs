/**
 * Shard-write memory benchmark (Pass 2's remaining memory risk).
 *
 * The question this answers: can the largest realistic index shard be serialised
 * inside the container's memory limit? A shard's payload is bounded by the document
 * frequency of the terms it holds, and the worst realistic case is a very common
 * `token` / `contactToken` term (a common first name over ~99 M contacts).
 *
 * Method: build a synthetic payload of N postings, serialise it through the ACTUAL
 * production path (`shardJsonParts` streamed through gzip, which is what the build
 * now calls), and sample process RSS at 2 ms while doing so. N is swept, and the
 * per-posting cost is taken from the largest measurements so a small-N baseline
 * cannot flatter the result. The same sweep is run through the OLD path
 * (`JSON.stringify` + `gzipSync`) for comparison.
 *
 *   bun scripts/benchmark-shard-memory.mjs
 *   bun scripts/benchmark-shard-memory.mjs --sizes 1000000,4000000,8000000
 *
 * Nothing is extrapolated silently: every measured point is printed, and the
 * projection states which points it was fitted from.
 */

import { createGzip, gzipSync } from "node:zlib";

import { shardJsonParts } from "../tools/indexer/src/build.ts";

const argv = process.argv.slice(2);
function list(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return String(argv[index + 1])
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/** Container `standard-1` (wrangler.toml): the limit this run must fit inside. */
const CONTAINER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
/** Working budget for the payload: the merge holds its own state next to it. */
const SAFE_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

const sizes = list("sizes", [500_000, 2_000_000, 8_000_000]);
const TERMS = 4;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Highest RSS seen while `fn` runs (sampled every 2 ms). */
async function peakRssDuring(fn) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = process.memoryUsage().rss;
    if (now > peak) peak = now;
  }, 2);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  const after = process.memoryUsage().rss;
  if (after > peak) peak = after;
  return peak;
}

/** One synthetic shard: one very common term plus a few ordinary ones. */
function buildPayload(postings) {
  const terms = Object.create(null);
  const perTerm = Math.max(1, Math.floor(postings / TERMS));
  for (let term = 0; term < TERMS; term += 1) {
    const refs = new Array(perTerm);
    const q = new Array(perTerm);
    for (let index = 0; index < perTerm; index += 1) {
      refs[index] = term * 20_000_000 + index;
      q[index] = 100 + (index % 40);
    }
    terms[`term${term}`] = { refs, q };
  }
  return { terms };
}

async function streamedWrite(terms) {
  const stream = createGzip({ level: 6 });
  let bytes = 0;
  let chunks = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    chunks += 1;
  });
  const finished = new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  for await (const part of shardJsonParts(terms)) {
    if (!stream.write(part)) await new Promise((resolve) => stream.once("drain", resolve));
  }
  stream.end();
  await finished;
  return { bytes, chunks };
}

async function main() {
  console.log("\nShard-write memory benchmark (peak RSS, sampled every 2 ms)");
  console.log(`  payload shape        ${TERMS} terms, evenly split (a token shard)\n`);
  console.log("  postings      old peak   old object    new peak   new object   new B/posting");

  const rows = [];
  for (const postings of sizes) {
    // Old path: stringify the whole payload, then gzip it.
    const beforeOld = process.memoryUsage().rss;
    let oldOut = 0;
    const oldTerms = buildPayload(postings).terms;
    const oldPeak = await peakRssDuring(async () => {
      const text = JSON.stringify({ terms: oldTerms });
      const body = gzipSync(Buffer.from(text, "utf8"), { level: 6 });
      oldOut = body.length;
      // Keep the compressed output alive for the whole measurement.
      if (body.byteLength !== oldOut) throw new Error("unreachable");
    });

    // New path: stream the same payload through the production serialiser.
    const baseline = process.memoryUsage().rss;
    const payload = buildPayload(postings);
    let gzipBytes = 0;
    const newPeak = await peakRssDuring(async () => {
      const result = await streamedWrite(payload.terms);
      gzipBytes = result.bytes;
    });

    const row = {
      postings,
      oldPeak: oldPeak - beforeOld,
      newPeak: newPeak - baseline,
      gzipBytes,
      perPosting: (newPeak - baseline) / postings,
    };
    rows.push(row);
    console.log(
      `  ${postings.toLocaleString().padStart(10)}  ${mb(row.oldPeak).padStart(10)}  ${mb(oldOut).padStart(10)}  ` +
        `${mb(row.newPeak).padStart(10)}  ${mb(gzipBytes).padStart(10)}  ${row.perPosting.toFixed(1).padStart(13)}`,
    );
  }

  // Fit the per-posting cost from the LARGEST two points: a fixed baseline does not
  // distort the slope there, and the slope is what a bigger shard pays.
  const sorted = [...rows].sort((a, b) => a.postings - b.postings);
  const big = sorted.slice(-2);
  const newSlope = big.length > 1 ? (big[1].newPeak - big[0].newPeak) / (big[1].postings - big[0].postings) : sorted[sorted.length - 1].perPosting;
  const gzipSlope = big.length > 1 ? (big[1].gzipBytes - big[0].gzipBytes) / (big[1].postings - big[0].postings) : rows[rows.length - 1].gzipBytes / rows[rows.length - 1].postings;
  console.log(
    `\n  fitted from ${big.map((row) => row.postings.toLocaleString()).join(" and ")} postings: ` +
      `${newSlope.toFixed(2)} B RSS and ${gzipSlope.toFixed(3)} B gzip per posting`,
  );

  console.log("\n  projection for a 99 M-contact corpus (config: 256 token shards, 512 trigram):");
  for (const [label, df] of [
    ["common first name, 1.5 M postings", 1_500_000],
    ["very common token, 4 M postings", 4_000_000],
    ["implausible worst case: every contact one token, 99 M postings", 99_000_000],
  ]) {
    const projected = df * newSlope;
    console.log(
      `    ${label.padEnd(60)} ≈ ${mb(projected).padStart(9)} RSS · ${mb(df * gzipSlope).padStart(9)} object  ` +
        `${projected < SAFE_BUDGET_BYTES ? "PASS" : "FAIL"} (budget ${mb(SAFE_BUDGET_BYTES)})`,
    );
  }
  console.log(
    `\n  container limit ${mb(CONTAINER_MEMORY_BYTES)}; working budget ${mb(SAFE_BUDGET_BYTES)} for the payload.\n` +
      "  The streaming write adds only the compressor's state (tens of KB) on top of the\n" +
      "  payload, and each term's arrays are released as it is written. A projected shard\n" +
      "  over budget is a signal to raise the shard count in the indexer config, not to\n" +
      "  raise the container size.\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
