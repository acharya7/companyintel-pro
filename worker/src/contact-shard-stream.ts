/**
 * Bounded-memory reader for the contact name index.
 *
 * WHY THIS EXISTS
 * ---------------
 * A contact-trigram shard is a gzip-compressed JSON object whose postings for one
 * very common gram can hold millions of contact ids. The original reader called
 * `JSON.parse` on the whole decompressed object, so the isolate had to hold BOTH
 * the compressed object and its full decompressed text plus the parsed arrays in
 * memory. At 86 M contacts the largest shard is ~113 MB compressed (~400 MB of
 * JSON), which cannot fit in a Worker isolate and produced exactly the OOM
 * failure this module removes.
 *
 * The format is fixed by the writer:
 *
 *   {"terms":{"<term>":{"ids":["p_…","p_…"],"q":[255,160]},"<term>":…}}
 *
 * and a query only needs the postings of the handful of terms it looks up. This
 * reader streams the decompressed text instead of buffering it, finds the exact
 * key with `indexOf` (the writer emits `"term":{"ids":[` with no whitespace), keeps
 * only the ids of the requested terms, stops after a per-term cap, and cancels the
 * response as soon as every requested term has been answered. Peak memory is
 * therefore `terms × cap` id strings plus one text chunk, independent of shard
 * size.
 *
 * It is deliberately a scanner, not a general JSON parser: the postings objects
 * are machine-written in exactly one shape, and the tests feed the real indexer's
 * output through it, so a change to that shape fails loudly rather than silently
 * returning nothing.
 */

/** Per-term bound on collected ids (a search only ranks a few hundred). */
export const DEFAULT_IDS_PER_TERM = 4000;
/**
 * Decompressed characters one shard read may scan.
 *
 * High enough to reach a term near the end of the largest shard (~400 MB of JSON)
 * while still bounding a malformed/corrupt object. A real shard read normally
 * stops as soon as its key is found.
 */
export const DEFAULT_MAX_CHARS = 640 * 1024 * 1024;
/** Separator emitted by the writer between the refs array and the quality array. */
const ARRAY_SEPARATOR = '],"q":[';

export interface ContactPostingsScan {
  ids: string[];
  q: number[];
}

export interface ContactShardScan {
  postings: Map<string, ContactPostingsScan>;
  /** True when at least one requested term's list was cut at the per-term cap. */
  capped: boolean;
  /** True when the scan stopped before the end of the object. */
  stoppedEarly: boolean;
  /** Decompressed characters inspected. */
  scannedChars: number;
}

interface PendingTerm {
  term: string;
  ids: string[];
  q: number[];
  capped: boolean;
  /** True while inside a quoted id that continues in the next chunk. */
  inString: boolean;
  /** Characters of the id currently being read (bounded by an id's length). */
  buffer: string;
}

/** `"term":{"ids":[` — exactly how the indexer serialises a postings object. */
function needleFor(term: string): string {
  return `${JSON.stringify(term)}:{"ids":[`;
}

/**
 * Consume ids from `text[start,end)` with a character-level state machine.
 *
 * This replaced a separator (`],"q":[`) search that had to be stitched across
 * chunk boundaries; an ids array ends with `]`, ids never contain `]`, and a
 * quoted id can be continued in `pending.buffer` without retaining any of the
 * array's text. Memory is therefore one id plus the id list, regardless of how
 * large the postings array is.
 */
function consumeIds(
  text: string,
  start: number,
  end: number,
  pending: PendingTerm,
  cap: number,
): { ended: boolean; next: number } {
  let cursor = start;
  while (cursor < end) {
    const ch = text[cursor];
    if (pending.inString) {
      if (ch === "\\") {
        pending.buffer += text[cursor + 1] ?? "";
        cursor += 2;
        continue;
      }
      if (ch === '"') {
        if (pending.ids.length < cap) {
          if (pending.buffer) {
            pending.ids.push(pending.buffer);
            // Quality is not read: the prominence byte only nudges pre-ranking,
            // and the stage weight dominates it.
            pending.q.push(128);
          }
        } else if (pending.buffer) {
          pending.capped = true;
        }
        pending.buffer = "";
        pending.inString = false;
      } else {
        pending.buffer += ch;
      }
      cursor += 1;
      continue;
    }
    if (ch === '"') {
      pending.inString = true;
      pending.buffer = "";
    } else if (ch === "]") {
      return { ended: true, next: cursor + 1 };
    }
    cursor += 1;
  }
  return { ended: false, next: end };
}

/**
 * Stream one contact shard and return postings for `terms`.
 *
 * `stream` must yield decompressed UTF-8 bytes. A `null` stream (missing object)
 * yields an empty scan.
 */
export async function scanContactShardStream(
  stream: ReadableStream<Uint8Array> | null,
  terms: string[],
  options: { idsPerTerm?: number; maxChars?: number } = {},
): Promise<ContactShardScan> {
  const wanted = [...new Set(terms.filter(Boolean))];
  const cap = Math.max(1, options.idsPerTerm ?? DEFAULT_IDS_PER_TERM);
  const maxChars = Math.max(1024, options.maxChars ?? DEFAULT_MAX_CHARS);
  const postings = new Map<string, ContactPostingsScan>();
  let capped = false;
  let scannedChars = 0;
  if (!stream || wanted.length === 0) {
    return { postings, capped, stoppedEarly: false, scannedChars };
  }

  const targets = wanted.map((term) => ({ term, needle: needleFor(term), found: false }));
  const maxNeedle = targets.reduce((max, target) => Math.max(max, target.needle.length), 0);

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  /** Text retained between chunks while scanning for a key. */
  let carry = "";
  let pending: PendingTerm | null = null;
  // A capped term's remaining postings cannot change the candidate set; stop.
  let cappedStop = false;

  const finalize = (target: PendingTerm) => {
    postings.set(target.term, { ids: target.ids, q: target.q });
    if (target.capped) {
      capped = true;
      cappedStop = true;
    }
  };

  try {
    while (!cappedStop) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      scannedChars += decoded.length;

      let text: string;
      let cursor = 0;

      if (pending) {
        const consumed = consumeIds(decoded, 0, decoded.length, pending, cap);
        if (!consumed.ended) {
          if (scannedChars >= maxChars) break;
          continue;
        }
        finalize(pending);
        pending = null;
        text = decoded;
        cursor = consumed.next;
      } else {
        text = carry + decoded;
      }

      // Find the earliest occurrence of any requested key in this chunk. Native
      // indexOf is an order of magnitude faster than a JSON regex over hundreds of
      // megabytes of text, which is what keeps a shard read inside the CPU budget.
      while (cursor < text.length) {
        let best = -1;
        let bestTarget: (typeof targets)[number] | null = null;
        for (const target of targets) {
          if (target.found) continue;
          const at = text.indexOf(target.needle, cursor);
          if (at !== -1 && (best === -1 || at < best)) {
            best = at;
            bestTarget = target;
          }
        }
        if (!bestTarget || best === -1) break;
        const idsStart = best + bestTarget.needle.length;
        const found: PendingTerm = { term: bestTarget.term, ids: [], q: [], capped: false, inString: false, buffer: "" };
        bestTarget.found = true;
        const consumed = consumeIds(text, idsStart, text.length, found, cap);
        if (!consumed.ended) {
          pending = found;
          break;
        }
        postings.set(bestTarget.term, { ids: found.ids, q: found.q });
        if (found.capped) {
          capped = true;
          cappedStop = true;
          break;
        }
        cursor = consumed.next;
      }

      if (pending) continue;
      if (cappedStop) break;
      if (targets.every((target) => target.found)) break;
      // Keep enough of the tail for a key that straddles two chunks.
      carry = text.length > maxNeedle ? text.slice(text.length - (maxNeedle - 1)) : text;
      if (scannedChars >= maxChars) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (pending) {
    // The stream ended inside an ids array (a truncated/corrupt object).
    postings.set(pending.term, { ids: pending.ids, q: pending.q });
    if (pending.capped) capped = true;
  }

  return { postings, capped, stoppedEarly: false, scannedChars };
}

/**
 * Stream the ids index for a set of contact ids and return their document refs.
 *
 * The ids shards are smaller than the name shards (~5 MB compressed each) but
 * there are 256 of them and a page of contacts is spread across ~50 of them.
 * Parsing every visited shard whole meant ~750 MB of decompressed JSON for one
 * person search — the second half of the memory/latency problem. The postings
 * value here is `{"refs":[-1],"q":[255]}`, so the same streaming key search
 * applies; only the array holds numbers instead of strings.
 *
 * Refs arrays are at most a handful of numbers, so the simplest correct approach
 * is to require the whole `…],"q":[` slice in one chunk; a key whose value
 * straddles a boundary is retained and retried with the next chunk.
 */
export async function scanRefShardStream(
  stream: ReadableStream<Uint8Array> | null,
  ids: string[],
  options: { refsPerId?: number; maxChars?: number } = {},
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!stream || wanted.length === 0) return out;
  const cap = Math.max(1, options.refsPerId ?? 2);
  const maxChars = Math.max(1024, options.maxChars ?? 32 * 1024 * 1024);
  const targets = wanted.map((id) => ({ id, needle: `${JSON.stringify(id)}:{"refs":[`, found: false }));
  const maxNeedle = targets.reduce((max, target) => Math.max(max, target.needle.length), 0);

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let scannedChars = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      scannedChars += decoded.length;
      const text = carry + decoded;
      carry = "";

      let cursor = 0;
      let needsMore = false;
      while (cursor < text.length) {
        let best = -1;
        let target: (typeof targets)[number] | null = null;
        for (const candidate of targets) {
          if (candidate.found) continue;
          const at = text.indexOf(candidate.needle, cursor);
          if (at !== -1 && (best === -1 || at < best)) {
            best = at;
            target = candidate;
          }
        }
        if (!target || best === -1) break;
        const start = best + target.needle.length;
        const end = text.indexOf(ARRAY_SEPARATOR, start);
        if (end === -1) {
          // Retain from the key start; the whole value is a few bytes, so this
          // cannot grow with the shard.
          carry = text.slice(best);
          needsMore = true;
          break;
        }
        const refs: number[] = [];
        for (const match of text.slice(start, end).matchAll(/-?\d+/g)) {
          if (refs.length >= cap) break;
          const ref = Number(match[0]);
          if (Number.isFinite(ref)) refs.push(ref);
        }
        target.found = true;
        out.set(target.id, refs);
        cursor = end + ARRAY_SEPARATOR.length;
      }

      if (targets.every((target) => target.found) || scannedChars >= maxChars) break;
      if (!needsMore && !carry) {
        carry = text.length > maxNeedle ? text.slice(text.length - (maxNeedle - 1)) : text;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}
