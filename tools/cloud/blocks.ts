/**
 * Alignment scan: where may a range legally start?
 *
 * The swarm cuts a 54 GB source into ~500 independent ranges. A cut is only valid
 * at a newline that is OUTSIDE a quoted field, and that is a global property of the
 * file's prefix — no amount of looking at the bytes near the cut can tell you. This
 * scanner therefore reads each fixed-size block once and records:
 *
 *   - the number of quote characters and physical newlines in the block;
 *   - the first newline that would be a record boundary if the block started
 *     outside quotes, and the first that would be one if it started inside quotes.
 *
 * The coordinator prefix-XORs the per-block quote counts, learns the real state at
 * each block start, and picks the matching candidate. This is exact for well-formed
 * RFC 4180 input (which the parser already requires): an escaped `""` pair does not
 * change quote state, and a pair split across a slice boundary is carried over.
 *
 * The scan deliberately does NOT parse CSV fields: it is the cheap pass. Parsing,
 * mapping and segment writing happen in the range tasks, on 16 containers at once.
 */

import { swarmKeys, type SwarmBlockDescriptor } from "../../src/shared/cloud/swarm";

import type { BlobStore } from "./store";

const QUOTE = 0x22;
const NEWLINE = 0x0a;

export interface ScanBlockOptions {
  store: BlobStore;
  version: string;
  sourceId: string;
  key: string;
  size: number;
  index: number;
  blockBytes: number;
  /** Bytes per ranged read (default 8 MiB). */
  sliceBytes?: number;
}

/**
 * Scan one block and write its descriptor to R2.
 *
 * The descriptor is written with a deterministic key, so a retried block overwrites
 * it rather than creating a second copy. The worker reads it back and reports the
 * summary to the coordinator, which is what makes block completion verifiable.
 */
export async function scanBlock(options: ScanBlockOptions): Promise<SwarmBlockDescriptor> {
  const start = options.index * options.blockBytes;
  const end = Math.min(options.size, start + options.blockBytes);
  const sliceBytes = Math.max(64 << 10, options.sliceBytes ?? 8 << 20);

  let inQuotes = false;
  /** A quote ended the previous slice while inside a field: is the next byte a quote too? */
  let pendingClose = false;
  let quotes = 0;
  let newlines = 0;
  let firstFalseEnd: number | null = null;
  let firstFalseLine: number | null = null;
  let firstTrueEnd: number | null = null;
  let firstTrueLine: number | null = null;

  let offset = start;
  while (offset < end) {
    const length = Math.min(sliceBytes, end - offset);
    const buffer = await options.store.getRange(options.key, offset, length);
    if (!buffer.length) break;

    for (let cursor = 0; cursor < buffer.length; cursor += 1) {
      if (pendingClose) {
        pendingClose = false;
        if (buffer[cursor] === QUOTE) {
          // `""` inside a quoted field: a literal quote, the field stays open.
          inQuotes = true;
          continue;
        }
        // The quote that ended the previous slice was a real closing quote.
      }
      const byte = buffer[cursor]!;
      if (byte === QUOTE) {
        quotes += 1;
        if (inQuotes) {
          const next = cursor + 1 < buffer.length ? buffer[cursor + 1] : undefined;
          if (next === QUOTE) {
            quotes += 1;
            cursor += 1;
            continue;
          }
          if (next === undefined) {
            pendingClose = true;
            continue;
          }
          inQuotes = false;
          continue;
        }
        inQuotes = true;
        continue;
      }
      if (byte !== NEWLINE) continue;

      newlines += 1;
      const endOffset = offset + cursor + 1;
      if (inQuotes) {
        if (firstTrueEnd === null) {
          firstTrueEnd = endOffset;
          firstTrueLine = newlines + 1;
        }
      } else if (firstFalseEnd === null) {
        firstFalseEnd = endOffset;
        firstFalseLine = newlines + 1;
      }
    }

    offset += buffer.length;
  }

  const descriptor: SwarmBlockDescriptor = {
    index: options.index,
    start,
    end,
    bytes: end - start,
    quotes,
    newlines,
    firstFalseEnd,
    firstFalseLine,
    firstTrueEnd,
    firstTrueLine,
  };
  await options.store.putJson(swarmKeys.block(options.version, options.sourceId, options.index), descriptor);
  return descriptor;
}

/** Read a block descriptor back from R2 (used by a worker to report the result). */
export async function readBlockDescriptor(
  store: BlobStore,
  version: string,
  sourceId: string,
  index: number,
): Promise<SwarmBlockDescriptor | null> {
  return store.getJson<SwarmBlockDescriptor>(swarmKeys.block(version, sourceId, index));
}
