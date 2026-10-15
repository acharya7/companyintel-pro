/**
 * String-similarity primitives used by the fuzzy search engine.
 *
 * Everything here is O(len) per pair and bounded, so it can run inside a
 * Cloudflare Worker without blowing the CPU budget.
 */

/** Generate padded character trigrams: "abc" -> [" ab", "abc", "bc "]. */
export function trigramsOf(value: string): string[] {
  const s = ` ${value} `;
  if (s.length < 3) return value ? [value] : [];
  const out: string[] = [];
  for (let i = 0; i + 3 <= s.length; i += 1) out.push(s.slice(i, i + 3));
  return out;
}

export function trigramSet(value: string): Set<string> {
  return new Set(trigramsOf(value));
}

/** Sørensen–Dice coefficient over two trigram sets (0..1). */
export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Levenshtein distance with an early exit once `max` is exceeded — the
 * difference between a bounded scan and an unbounded one on large candidate
 * sets. Returns `max + 1` when the distance is known to exceed `max`.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/** Normalized edit similarity in 0..1 (1 = identical). */
export function editSimilarity(a: string, b: string, max?: number): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  const limit = max ?? Math.ceil(longest * 0.5);
  const dist = boundedLevenshtein(a, b, limit);
  if (dist > limit) return 0;
  return 1 - dist / longest;
}

/** Maximum edit distance allowed for a query of this length. */
export function editBudgetFor(query: string): number {
  const len = query.length;
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  if (len <= 14) return 3;
  return Math.min(5, Math.floor(len / 4));
}

/** Longest common prefix length of two strings. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/** Token-level Jaccard overlap in 0..1. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (setB.has(t)) shared += 1;
  const union = new Set([...a, ...b]).size;
  return union ? shared / union : 0;
}
