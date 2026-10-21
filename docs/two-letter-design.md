# AA–ZZ letter buckets versus the current sharded index: a measured comparison

The rule for this decision is the one you set: **do not replace a working indexing
implementation without a demonstrated improvement.** This document measures the current
design and the proposed one on the same real data, states which numbers are measurements
and which are extrapolations, and ends with a staged plan that produces the missing
measurements (query latency and accuracy) before anything is switched.

## 1. The data everything is measured on

Live R2, `stg-bench-2026-10-21`, 2026-10-21 (read-only; the job is the 16 MB-per-source
bounded benchmark):

| Quantity | Measured |
| --- | --- |
| Source bytes read | 33,556,054 B (16 MB + 16 MB prefixes of `raw/file1.csv`, `raw/file2.csv`) |
| Rows indexed | 35,478 (36,432 read, 954 rejected) |
| Companies / contacts | **22,258 / 28,166** |
| Pass 1 rate (same CLI, real R2) | 36,432 rows in 45.2 s = **806 rows/s**, 0.71 MB/s (`index-reports/cloud-benchmark-cloud-bench-e.json`) |
| Pass 2 merge (container, measured) | 09:28:34 → 11:39:07 = **7,833 s** for 16 partitions, 35,478 rows = **4.5 rows/s**, **11,264** posting-part PUTs / 19,751,087 B |
| Finalize (container, previous build) | 242 → 531 index objects in 1,077 s = **0.27 objects/s**, ~3.7 s per shard (one LIST + one PUT at ~1.8 s per R2 round trip) |
| Generated index bytes | `companies/` 1,347,117 B (90 objects) + `contacts/` 2,865,330 B (23) + `details/` 18,515,515 B (113) + `indexes/` ≥ 1,105,325 B = **≥ 23.8 MB**, ≈ **670 B per indexed row** |
| Full corpus | **64,261,999,620 B**; at the measured 1,086 rows/MB that is **≈ 69.8 M rows** (the 29.7 M in `docs/cost.md` is the csv1-only density, a lower bound) |

## 2. The current design, measured

Term → hash shard: `exact`, `prefix`, `token`, `trigram`, `ids` for companies (512 / 256 /
256 / 512 / 256 slots) and `token` / `prefix` / `trigram` for contacts (256 / 256 / 512).
A query computes the shard from the term and fetches exactly one object per kind.

Measured at 22,258 companies:

| Kind | Objects (populated / slots) | Bytes | Per object (min / median / max) |
| --- | --- | --- | --- |
| `exact` | 512 / 512 | 925,315 | 1,344 / **1,807** / 2,304 B |
| `prefix` | 15 / 256 (measured mid-finalize; most slots hold no term at this scale) | 180,010 | 10,808 / 11,477 / 15,790 B |

Two properties matter and are measured, not assumed:

* **No skew.** Hash sharding gives 512 objects within a 1.7× size band (1,344–2,304 B).
* **One request per lookup.** An exact lookup is one GET of ~1.8 KB at this scale.

Projected to 64.26 GB (×1,915 by source bytes, ×1,967 by rows):

* `exact` becomes ~1.77 GB over 512 shards → **~3.5 MB per shard**, i.e. an exact
  term hit fetches ~3.5 MB (still one R2 GET; immutable, so cacheable).
* Finalize has 1,792 + 1,024 + 80 ≈ **2,896 objects to write**, of which ~1,000–1,300 are
  populated at benchmark scale. The old build wrote all 2,896 and issued one LIST per
  shard; the new build lists once per kind, builds four at a time and skips empty
  shards, so the projected finalize is ~0.4× the request count and ~0.25× the wall time
  (measured request latency × concurrency), but that combination has not yet been
  measured on live data.

## 3. The proposed design, measured where it can be

Two-letter buckets (AA–ZZ) over the **22,258 real company names** already written to R2
by the merge (normalized name, first two A–Z letters; digit-leading names under a `#`
prefix). Measured distribution:

| Bucket statistic | Measured |
| --- | --- |
| Populated buckets | **583 of 676** (93 empty) |
| Largest bucket | **582 companies** (`CO`, 2.6% of all companies) |
| Median bucket | **9 companies** |
| Next largest | `UN` 485, `IN` 475, `TH` 448, `MA` 415, `CA` 364 |
| Buckets over 2,000 / 5,000 | **0 / 0** |

Projected to the full corpus (×1,967 rows):

* largest bucket ≈ **1.14 M companies**; median bucket ≈ **17,200 companies**;
* at the measured 41.6 compressed bytes per company (925,315 B / 22,258), one bucket
  object is ≈ **0.72 MB median** and ≈ **46 MB for `CO`**;
* 676 + 676 slots (≈ 1,166 populated by this distribution) instead of ~2,896 shard
  objects: **~40% fewer objects to write in finalize** and ~40% fewer index objects to
  store.

The 46 MB maximum is the design's real problem: it is 13× the current per-query fetch,
it exceeds a comfortable single Worker GET and a 128 MB isolate budget once decoded, and a
fuzzy query over `CO` sees 1.14 M candidates before any ranking. That is exactly why
**adaptive subdivision is not optional** in your architecture: with a 2 MB object cap
(≈ 50 k companies) `CO` needs ~23 children, and the median bucket needs none.

## 4. Side-by-side

| Dimension | Current (hash shards) | AA–ZZ buckets | Basis |
| --- | --- | --- | --- |
| Pass 1 time | 806 rows/s measured | unchanged — same parser, same segments | measured vs code structure |
| Merge time | 4.5 rows/s measured (request-bound: 11,264 part PUTs) | unchanged | measured vs code structure |
| Finalize objects | 2,896 (1,792 + 1,024 + 80) | 1,352 slots, ~1,166 populated | measured slot counts + bucket distribution |
| Finalize wall time (projected, new build) | ~0.4× old | ~0.25× old | object counts + measured 1.8 s/request |
| Index objects stored | ~2,896 | ~1,166 | measured |
| Exact-lookup R2 ops | 1 GET | 1 GET | both |
| Exact-lookup bytes, full corpus | ~3.5 MB (median = max) | **0.72 MB median**, 46 MB worst, 2 MB cap makes it ≤ 2 MB | measured sizes, ×1,915 |
| Fuzzy/prefix fetch | 1 GET per trigram/prefix shard (1.8 KB now, ~3.5 MB at scale) | 1 GET per bucket, then in-object scan | measured sizes |
| Skew | 1.7× band | 65× between median and `CO`; 0 buckets > 2 k at benchmark scale | measured |
| Search accuracy | exact by construction; fuzzy candidates bounded by the term's posting list | exact still exact **within** the bucket; fuzzy over a bucket can truncate unless subdivided | analysis |
| Full-corpus incremental cost | **$12.18 expected** ($3–6 realistic, $35.26 high) | ±1% (≈1,700 fewer PUTs ≈ $0.008) | `docs/cloud.md` forecast + R2 prices |
| Browse/pagination | not indexed by letter; needs a scan or a separate structure | native (`AA`–`AZ` pages, cache-friendly) | design |

**The measured conclusion:** AA–ZZ is not a cost optimisation (it saves under a cent) and
it is not faster for indexing (Pass 1 and the merge dominate and are unchanged). It is a
**query-locality** design: it cuts median per-query bytes ~5× and gives alphabetical
browsing, at the price of a 13× heavier worst case that requires subdivision. Replacing
the current layout outright would be a regression for exact lookups on common letters and
for the accuracy guarantee unless the subdivision and a separate exact structure are
built first.

## 5. Plan (evidence first, no cutover without it)

**P0 — baseline on the real index (partly done here).** Freeze a golden query set of ~200
queries (exact, prefix, fuzzy, contact-name, company→contacts) against the completed
benchmark version, and record per query: R2 objects fetched, bytes, p50/p95 latency,
precision/recall against the full record set. The measured objects/bytes above are the
starting point; the query set needs the completed version.

**P1 — bucket planner offline (no index change).** Compute AA–ZZ + subdivision from the
completed benchmark's `companies/` and `contacts/` objects: bucket counts, largest bucket,
children needed at a 2 MB cap, projected object bytes. Compare with §3; if the measured
plan does not show ≤2 MB objects and ≤5× median byte reduction, stop.

**P2 — dual-write into a new version.** In a **new version id** (never in place), write
`letters/<v>/companies/<AA>.json.gz` and `contacts/<AA>.json.gz` with compact pointers
(`ref` + quality byte + contact-owner ref, no names duplicated) alongside the existing
shards. The directory gains a `letters` block, so a reader can tell "absent" from "empty".
All original fields stay in `details/` exactly as now.

**P3 — cache-first reader behind a flag.** Exact lookups keep the hash shard unless the
bucket is small (measured threshold), fuzzy/prefix use the bucket, every read goes through
the existing immutable-object cache (`worker/src/search-cache.ts`), and subdivision is
applied at write time only where a bucket exceeds the cap.

**P4 — shadow evaluation, then decide.** Run P0's query set against both layouts on the
same data and require: identical precision/recall, p95 latency no worse, median bytes/query
≤ 0.5× current, worst-case object ≤ 2 MB, and finalize objects ≤ 0.7× current. Only then
make the bucket path the default; otherwise keep the hash shards and use AA–ZZ purely for
browse pages.

Budget: the measured full-corpus forecast is **$12.18 expected** (conservative; $3–6
realistic, $35.26 high) plus ~$0.70/month storage — inside your $50 preference with
headroom. Nothing in P0–P3 changes the corpus, `raw/`, or an existing version; each step
writes only new keys under a new version id.
