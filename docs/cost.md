# Cost model and measured performance

Unit prices below are the documented Cloudflare list prices (checked October 2026). Treat the
monthly totals as **estimates**: they use the pricing and your stated usage (100 / 300 / 1,000
searches per day), plus storage estimates that you must replace with the real numbers from your
sample indexing run. No paid service is enabled by this document.

## Documented unit prices

| Item | Price | Source |
| --- | --- | --- |
| R2 Standard storage | $0.015 per GB-month (10 GB-month free) | <https://developers.cloudflare.com/r2/pricing/> |
| R2 Class A (writes, lists) | $4.50 per million requests (1M/month free) | same |
| R2 Class B (reads) | $0.36 per million requests (10M/month free) | same |
| R2 egress | free | same |
| Workers Free | 100,000 requests/day, 10 ms CPU per request | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Workers Paid | from $5/month, 10M requests/month included, $0.30/million after, CPU-time billing | same |
| Cloudflare Access (Zero Trust) | free tier covers up to 50 users | <https://www.cloudflare.com/plans/> |

## Storage estimate

| Object class | Estimate | Monthly |
| --- | --- | --- |
| `raw/` originals (given) | 60 GB | $0.90 |
| `indexes/` + `companies/` + `contacts/` | 9–20 GB for ~10M companies (measure it: `tools/indexer` prints output size) | $0.12–$0.30 |
| `app-data/` + `backups/` | < 0.1 GB | ≈ $0 |
| **Total** | | **≈ $1.00–$1.20** |

R2 free tier covers 10 GB-month of storage, so subtract up to $0.15 if you stay under it.

## Operation estimate

Per search the Worker reads a bounded set of small objects:

```
1 exact shard (1 per query variant)
+ up to 6 prefix shards
+ up to 10 token shards
+ up to 14 trigram shards
+ up to SEARCH_MAX_HYDRATE (default 16) company profile partitions
= measured 24–35 objects, ≈ 0.4–0.5 MB per cold fuzzy query
```

The hydration line is the one that used to dominate: it is now a ceiling rather than a
consequence of how many candidates retrieval produced (see docs/architecture.md for the
before/after measurements). Exact and short queries read fewer still — a query whose page
fills from confident hits stops before the fuzzy tail — and the four cache layers absorb
repeats, so realistic figures are far below these cold numbers.

| Usage | Searches/month | R2 Class B (at ~30 reads/search) | Class B cost (10M free) |
| --- | --- | --- | --- |
| 100 searches/day | 3,000 | 90,000 | $0 |
| 300 searches/day | 9,000 | 270,000 | $0 |
| 1,000 searches/day | 30,000 | 900,000 | $0 |

Even the worst case (35 read objects per search, 1,000 searches/day) is ~1.05 M Class B
operations/month — still inside the 10M free allowance. **Class A** operations are dominated by
the initial index upload (a few thousand PUTs, once per version) and occasional lead writes;
30,000 lead writes/month would still be under the 1M free allowance.

## Workers request and CPU estimate

1,000 searches/day is ~30,000 API requests/month, plus asset requests. That is ~0.03% of the
Free plan's 100,000 requests/day. Requests are not the constraint; **CPU time** per request is.

Measured on the sandbox this repository was developed in (`bun scripts/benchmark-search.mjs
--companies 50000 --repeat 5`, in-process engine, index build 1.25 s / 102 MB heap — rerun on
your own machine, preferably with `--companies 200000`):

| Query class | median | p95 | candidates scored |
| --- | --- | --- | --- |
| exact ("Microsoft Corporation") | 2.8 ms | 3.3 ms | 400 |
| legal-suffix variant ("Infosys Ltd") | 6.3 ms | 12.4 ms | 400 |
| abbreviation ("ibm") | 0.02 ms | 0.06 ms | 2 |
| short prefix ("tat") | 0.5 ms | 2.9 ms | 213 |
| single typo ("Microsft") | 0.02 ms | 0.05 ms | 2 |
| transposition ("Mircosoft") | 5.4 ms | 9.4 ms | 400 |
| multi-token ("international business machines") | 0.06 ms | 0.11 ms | 4 |
| word split ("Total Energies") | 5.9 ms | 10.1 ms | 400 |
| no result | 0.02 ms | 0.06 ms | 0 |

Repeat runs on this shared sandbox vary by roughly 2× (identical query, 2.5–5.4 ms median), so
treat these as an order of magnitude, not a specification. Two optimizations made after the
first measurement are already included: exact normalized matches return early without running
the token/whole-string fuzzy passes, and query trigrams plus per-document trigram sets are
cached instead of rebuilt per candidate.

Labelled relevance on the same corpus: **recall@1 0.939, recall@5 0.97, 0 false positives** on
the "must not match" queries (`tests/fixtures/companies.ts`).

Scoring cost scales with the candidate budget (`maxScored = 400`), **not** with corpus size, so
these figures hold at 10M companies — that is the whole point of the bounded two-stage design.

Interpretation:

- The **median** query is comfortably inside the Free plan's 10 ms CPU budget.
- The **worst-case fuzzy** query (word-split / heavy typo) measured ~10 ms p95, which can exceed
  10 ms CPU on the Free plan. Two honest options: keep the Free plan and accept occasional
  `1102 Worker exceeded CPU time` errors on the heaviest fuzzy queries, or move to Workers Paid
  ($5/month) which removes the 10 ms ceiling. **This is an approval decision — no paid plan has
  been activated, and none is required to finish development.**
- Re-measure in production with `wrangler tail` (CPU time per request) before deciding; the
  sandbox timings are a proxy, not a production measurement.

### If the Paid plan turns out to be the practical choice

Workers Paid is **$5/month and includes 10 M requests plus 30 M CPU-milliseconds**, with overage
at $0.30 per additional million requests and $0.02 per additional million CPU-ms
([Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
Against this workload that is not the binding number:

| Scenario | Requests/month | CPU-ms/month at ~20 ms/query | Paid cost |
| --- | --- | --- | --- |
| 100 searches/day | 0.003 M | 0.06 M (0.2% of allowance) | **$5.00** |
| 1,000 searches/day | 0.03 M | 0.6 M (2% of allowance) | **$5.00** |
| 30,000 searches/day | 0.9 M | 18 M (60% of allowance) | **$5.00** |

So the realistic paid cost is the $5 minimum itself — CPU overage would only start somewhere
around 45,000–50,000 searches/day at the measured ~20 ms, and even then at $0.02 per million
CPU-ms. The reason to choose Paid is the **10 ms per-invocation ceiling**, not the bill: the
Free plan fails hard (`1102`) when a request exceeds it, and the measured cold-query cost after
the hydration bound (~20 ms in Bun on a sandbox vCPU, ~0.45 MB read, ~20 candidates scored) is
close enough to that line that only a `wrangler tail` measurement on real hardware can settle
it. Drop `SEARCH_MAX_HYDRATE` to 8 if a deployment measures too high.

## Total monthly estimate

| Scenario | Storage | Operations | Workers | Total |
| --- | --- | --- | --- | --- |
| Free Workers, 100–1,000 searches/day | ≈ $1.00–1.20 | $0 | $0 | **≈ $1–1.20** |
| Paid Workers (if the fuzzy CPU ceiling is hit) | ≈ $1.00–1.20 | $0 | $5.00 | **≈ $6.00–6.20** |

Backups and staging objects are small; deleting superseded versions (keeping one previous for
rollback) keeps storage flat.

## How to replace these estimates with measurements

1. Run the samples, then the full indexer; it prints input size, output size and object count.
2. `bun scripts/benchmark-search.mjs --companies 200000` on your Windows machine.
3. After deployment: `bunx wrangler tail` for CPU time and errors; Cloudflare dashboard → R2 for
   Class A/B operation counts; Workers analytics for request counts.
4. Update this table with your numbers. Nothing here should be presented as a measurement until
   it comes from steps 2–3.
