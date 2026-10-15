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
| `indexes/` + `companies/` + `contacts/` | 8–20 GB for ~10M companies (measure it: `tools/indexer` prints output size) | $0.12–$0.30 |
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
+ up to 24 company/contact partitions to hydrate the budgeted candidates
= worst case ≈ 30 shard objects + hydrated partitions per fuzzy query
```

Exact and short queries typically read 2–4 objects (the branch on `directory.json` is cached in
the isolate), and the four cache layers absorb repeats, so realistic figures are far below the
worst case.

| Usage | Searches/month | R2 Class B (at ~20 reads/search) | Class B cost (10M free) |
| --- | --- | --- | --- |
| 100 searches/day | 3,000 | 60,000 | $0 |
| 300 searches/day | 9,000 | 180,000 | $0 |
| 1,000 searches/day | 30,000 | 600,000 | $0 |

Even the worst case (30 read objects per search, 1,000 searches/day) is ~900,000 Class B
operations/month — still inside the 10M free allowance. **Class A** operations are dominated by
the initial index upload (a few thousand PUTs, once per version) and occasional lead writes;
30,000 lead writes/month would still be under the 1M free allowance.

## Workers request and CPU estimate

1,000 searches/day is ~30,000 API requests/month, plus asset requests. That is ~0.03% of the
Free plan's 100,000 requests/day. Requests are not the constraint; **CPU time** per request is.

Measured on the sandbox this repository was developed in (Bun, in-process engine, 50,000-company
corpus — rerun on your own machine with `bun scripts/benchmark-search.mjs`):

| Query class | median | p95 | candidates scored |
| --- | --- | --- | --- |
| exact ("Microsoft Corporation") | 3.6 ms | 3.9 ms | 400 |
| legal-suffix variant ("Infosys Ltd") | 6.3 ms | 12.5 ms | 400 |
| abbreviation ("ibm") | 0.04 ms | 0.07 ms | 2 |
| short prefix ("tat") | 0.7 ms | 6.2 ms | 213 |
| single typo ("Microsft") | 0.04 ms | 0.14 ms | 2 |
| transposition ("Mircosoft") | 3.4 ms | 7.4 ms | 400 |
| multi-token ("international business machines") | 0.05 ms | 0.12 ms | 4 |
| word split ("Total Energies") | 12.6 ms | 13.0 ms | 400 |
| no result | 0.03 ms | 0.08 ms | 0 |

Labelled relevance on the same corpus: **recall@1 0.939, recall@5 0.97, 0 false positives** on
the "must not match" queries (`tests/fixtures/companies.ts`).

Scoring cost scales with the candidate budget (`maxScored = 400`), **not** with corpus size, so
these figures hold at 10M companies — that is the whole point of the bounded two-stage design.

Interpretation:

- The **median** query is comfortably inside the Free plan's 10 ms CPU budget.
- The **worst-case fuzzy** query (word-split / heavy typo) measured ~13 ms, which can exceed
  10 ms CPU on the Free plan. Two honest options: keep the Free plan and accept occasional
  `1102 Worker exceeded CPU time` errors on the heaviest fuzzy queries, or move to Workers Paid
  ($5/month) which removes the 10 ms ceiling. **This is an approval decision — no paid plan has
  been activated, and none is required to finish development.**
- Re-measure in production with `wrangler tail` (CPU time per request) before deciding; the
  sandbox timings are a proxy, not a production measurement.

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
