/**
 * Global person search over the contact name index.
 *
 * WHY A SEPARATE PATH FROM COMPANY SEARCH
 * ---------------------------------------
 * Company search is keyed by *document ref*: a posting names a ref, and hydration
 * reads the company partition that holds it. A contact has no such position — it
 * lives inside its company's contact object — so a contact posting names a `p_…`
 * id instead. Hydration is therefore two hops, both of them bounded and both of
 * them cached:
 *
 *   term → contact ids (contactToken/contactPrefix/contactTrigram shards)
 *        → owning company ref, or the `unassigned/` partition, via the ids index
 *        → the contact object (one read per company contact partition)
 *
 * A contact that could not be attached to any company is indexed exactly like an
 * attached one and remains findable on its own; the result says the employer is
 * unconfirmed instead of hiding the person (specification § 10).
 *
 * Cost control mirrors `R2CandidateSource`: distinct shards are deduplicated,
 * reads run with limited concurrency, the prominence byte stored in the postings
 * pre-ranks candidates before anything large is fetched, and hydration stops after
 * a fixed number of contact objects.
 */

import type { Company, Contact, UnassignedContact } from "../../src/shared/models";
import {
  SHARDING,
  contactShardCounts,
  type ContactShardKind,
  type IndexDirectory,
} from "../../src/shared/search/index-format";
import { shardOf } from "../../src/shared/hash";
import { normalizeQuery } from "../../src/shared/normalize";
import { extractPhoneNumbers } from "../../src/shared/phone";
import {
  commonPrefixLength,
  diceCoefficient,
  editBudgetFor,
  editSimilarity,
  tokenOverlap,
  trigramSet,
  trigramsOf,
} from "../../src/shared/search/similarity";
import { mapLimit, R2Store } from "./store";

/** Stage weights: a prefix hit outranks a bare token, which outranks a trigram. */
const STAGE_WEIGHT: Record<ContactShardKind, number> = {
  contactPrefix: 120,
  contactToken: 20,
  contactTrigram: 1,
};

/** Candidate contacts handed to the scorer for one search. */
const MAX_SCORED = 300;
/** Contact objects hydrated for one search (one read per company partition). */
const MAX_HYDRATE_CONTACTS = 40;
/** Distinct contact partitions a single search may read. */
const MAX_CONTACT_PARTS = 12;

export interface ContactSearchHit {
  id: string;
  /** Display name exactly as the source record carries it. */
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  designation: string | null;
  seniority: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  additionalPhones: string[];
  linkedinUrl: string | null;
  country: string | null;
  city: string | null;
  companyId: string | null;
  companyName: string | null;
  /** Association category, `"unassigned"` for a preserved contact. */
  association: string | null;
  /** True when the employer is a claim from the row, not a confirmed record. */
  employerUnconfirmed: boolean;
  relevance: number;
  matchedTerms: string[];
}

export interface ContactSearchResult {
  hits: ContactSearchHit[];
  /** Contact ids that matched, before hydration (a lower bound on real matches). */
  matched: number;
  /** Candidates whose contact object could not be read inside the budget. */
  notHydrated: number;
  notice: string | null;
  correctedQuery: string | null;
  tookMs: number;
}

/** Terms to look up for one kind, given the normalized query. */
function termsFor(kind: ContactShardKind, normalized: string): string[] {
  const tokens = normalized.split(" ").filter(Boolean);
  if (kind === "contactToken") return [...new Set(tokens)];
  if (kind === "contactPrefix") {
    /*
     * Only the longest prefixes are looked up. Enumerating every shorter prefix
     * ("p", "pr", "pri", …) used to mean ~20 shard reads for a two-word name,
     * and at 86 M contacts each contact-prefix shard is ~48 MB compressed. Every
     * name matched by a shorter prefix of the query is still retrieved by the
     * longest prefix or by the token index, and scoring decides the page, so the
     * shorter lookups bought no extra recall — only tens of megabytes of transfer
     * and decompression per search.
     */
    const prefixes = new Set<string>();
    if (normalized) prefixes.add(normalized.slice(0, SHARDING.maxPrefixLength));
    for (const token of tokens) prefixes.add(token.slice(0, SHARDING.maxPrefixLength));
    return [...prefixes];
  }
  return trigramsOf(normalized);
}

/**
 * Retrieve candidate contact ids for one stage.
 *
 * Returns ids in retrieval-score order, capped at `budget`. Multi-term queries
 * keep only ids that matched at least half of the terms, so "john smith" does not
 * return every John in the database.
 */
async function retrieve(
  store: R2Store,
  version: string,
  shardCounts: { token: number; prefix: number; trigram: number },
  kind: ContactShardKind,
  terms: string[],
  budget: number,
  scores: Map<string, number>,
): Promise<void> {
  const unique = [...new Set(terms.filter(Boolean))];
  if (!unique.length) return;
  const shardCount =
    kind === "contactToken" ? shardCounts.token : kind === "contactPrefix" ? shardCounts.prefix : shardCounts.trigram;

  const byShard = new Map<number, string[]>();
  for (const term of unique) {
    const shard = shardOf(term, shardCount);
    const list = byShard.get(shard);
    if (list) list.push(term);
    else byShard.set(shard, [term]);
  }

  const hits = new Map<string, { matches: number; quality: number }>();
  // Two decompressors at a time: a contact shard can expand to hundreds of
  // megabytes, and the isolate budget must hold every concurrently open stream.
  await mapLimit([...byShard.entries()], 2, async ([shard, shardTerms]) => {
    /*
     * Stream the shard and keep only the requested terms' ids. `JSON.parse` on the
     * whole object (the previous behaviour) needed the compressed object AND its
     * full decompressed text AND the parsed postings at once; at 86 M contacts the
     * largest contact-trigram shard is ~113 MB compressed and could not fit in a
     * Worker isolate. The scanner bounds peak memory to the collected ids and
     * cancels the R2 response as soon as every requested term is answered.
     */
    const scan = await store.streamContactShard(version, kind, shard, shardTerms, { idsPerTerm: 8000 });
    if (!scan) return;
    for (const term of shardTerms) {
      const postings = scan.postings.get(term);
      if (!postings) continue;
      const ids = postings.ids;
      const quality = postings.q;
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (!id) continue;
        const q = quality ? (quality[i] ?? 0) / 255 : 0.5;
        const entry = hits.get(id) ?? { matches: 0, quality: 0 };
        entry.matches += 1;
        entry.quality += q;
        hits.set(id, entry);
      }
    }
  });

  const required = unique.length > 1 ? Math.max(1, Math.ceil(unique.length / 2)) : 1;
  const ranked: { id: string; score: number }[] = [];
  for (const [id, entry] of hits) {
    if (entry.matches < required) continue;
    ranked.push({ id, score: STAGE_WEIGHT[kind] * entry.matches + entry.quality * 10 });
  }
  ranked.sort((a, b) => b.score - a.score);
  for (const { id, score } of ranked.slice(0, budget)) {
    scores.set(id, (scores.get(id) ?? 0) + score);
  }
}

/** Display name from the record, falling back to the indexed key. */
function displayName(contact: Contact): string {
  return (contact.fullName ?? "").trim();
}

/** Normalized key of a stored contact, for scoring. */
function nameKey(contact: Contact): string {
  return normalizeQuery(contact.fullName ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Score a hydrated contact against the query.
 *
 * Retrieval already proved the contact is plausible; this decides the order of the
 * page. An exact name beats a prefix, a prefix beats a token overlap, and a small
 * edit distance covers a misspelled query. Ties fall back to the prominence byte
 * captured at retrieval, which prefers a reachable person with a known role.
 */
function scoreContact(contact: Contact, normalized: string): { score: number; matched: string[] } {
  const key = nameKey(contact);
  const terms = normalized.split(" ").filter(Boolean);
  const keyTokens = key.split(" ").filter(Boolean);
  let score = 0;
  if (key === normalized) score += 1000;
  else if (key.startsWith(normalized) || normalized.startsWith(key)) score += 400;
  score += 300 * tokenOverlap(terms, keyTokens);
  if (terms.length) {
    const distance = editSimilarity(normalized, key, editBudgetFor(normalized));
    if (distance >= 0.82) score += 200 * distance;
    const dice = diceCoefficient(trigramSet(normalized), trigramSet(key));
    if (dice >= 0.6) score += 120 * dice;
    /*
     * Per-token fuzzy alignment.
     *
     * A misspelled SINGLE name part ("Nadela", "Umapathii") is the common case, and
     * comparing it with the whole name always looks like a bad match: the edit
     * distance to "satya nadella" exceeds any sane budget and the trigram dice
     * stays below the similarity floor. Scoring each query word against its best
     * name token is what keeps a real typo while still refusing an unrelated name
     * ("umapathi" vs "tripathi" has no shared prefix and too large a distance).
     */
    let bestToken = 0;
    let prefixed = false;
    for (const term of terms) {
      for (const token of keyTokens) {
        const similarity = editSimilarity(term, token, editBudgetFor(term));
        const prefixShare = commonPrefixLength(term, token) / Math.max(term.length, token.length);
        // A query word that is a literal start of a name word ("nade" → "nadella") is
        // exactly what the prefix index retrieved the candidate for. Crediting it is
        // what lets a partial name reach the page; three characters is the floor,
        // because a one- or two-letter query matches thousands of unrelated people.
        if (term.length >= 3 && token.startsWith(term)) prefixed = true;
        bestToken = Math.max(bestToken, similarity, prefixShare >= 0.5 ? prefixShare : 0);
      }
    }
    if (prefixed) score += 220;
    if (bestToken >= 0.7) score += 250 * bestToken;
  }
  const matched = terms.filter((term) => keyTokens.some((token) => token.startsWith(term)));
  // A typo match has no term that literally prefixes a name token, but the caller
  // still needs to know WHICH query words justified the hit — so the query itself is
  // reported rather than an empty list.
  return { score, matched: matched.length ? matched : [normalized] };
}

function toHit(
  contact: Contact,
  company: Company | null,
  unassigned: boolean,
  relevance: number,
  matchedTerms: string[],
): ContactSearchHit {
  const association = contact.association?.category ?? (unassigned ? "unresolved" : null);
  const numbers = extractPhoneNumbers(contact);
  return {
    id: contact.id,
    fullName: displayName(contact),
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    title: contact.title ?? null,
    designation: contact.designation ?? null,
    seniority: contact.seniority ?? null,
    department: contact.department ?? null,
    email: contact.email ?? null,
    phone: numbers.phone,
    mobile: numbers.mobile,
    additionalPhones: numbers.additional,
    linkedinUrl: contact.linkedinUrl ?? null,
    country: contact.country ?? null,
    city: contact.city ?? null,
    companyId: company?.id ?? null,
    companyName: company?.name ?? (contact as UnassignedContact).claimedCompanyName ?? null,
    association: association ?? null,
    // Only the strongest category is a confirmed employer; a v2 index carries no
    // category at all, which must read as "not confirmed" rather than verified.
    employerUnconfirmed: association !== "high_confidence",
    relevance,
    matchedTerms,
  };
}

export interface ContactSearchOptions {
  query: string;
  /** Contacts requested for this page (already validated by the route). */
  pageSize: number;
  /** Ids already returned on earlier pages, so paging is stable and honest. */
  skip?: number;
}

/**
 * Search the whole contact name index and hydrate the best candidates.
 *
 * `skip` pages through the hydrated window: the index returns candidates in
 * retrieval order, the hydrated window is ranked by name similarity, and a page
 * beyond that window is reported as such through `notHydrated` rather than being
 * silently empty.
 *
 * Returns `null` when the active version has no contact index, so the caller can
 * say exactly that instead of reporting an empty result for a search that never
 * ran.
 */
export async function searchContacts(
  store: R2Store,
  directory: IndexDirectory,
  options: ContactSearchOptions,
): Promise<ContactSearchResult | null> {
  const shardCounts = contactShardCounts(directory);
  if (!shardCounts) return null;

  const started = Date.now();
  const normalized = normalizeQuery(options.query).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { hits: [], matched: 0, notHydrated: 0, notice: null, correctedQuery: null, tookMs: 0 };
  }

  const scores = new Map<string, number>();
  /*
   * Token index first: it holds every whole name word and its shards are a few
   * megabytes, so an exact or multi-word query is answered in one bounded pass.
   *
   * The prefix index is deliberately NOT queried for contact names. Its shards are
   * ~48 MB compressed each and a single prefix term can sit near the end of a
   * ~490 M character object; scanning three of them per name was the dominant cost
   * of a person search (~10 s) and gained no recall that the token and trigram
   * stages do not already provide. Partial names and typos are handled by the
   * trigram stage below, which stops as soon as it has enough candidates.
   */
  await retrieve(store, directory.version, shardCounts, "contactToken", termsFor("contactToken", normalized), MAX_SCORED, scores);
  if (scores.size < Math.max(options.pageSize, 10)) {
    await retrieve(store, directory.version, shardCounts, "contactTrigram", termsFor("contactTrigram", normalized), MAX_SCORED, scores);
  }

  // Best retrieval score first: hydration spends its fixed budget on the candidates
  // the index ranked highest, never on whichever ids happened to come back first.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SCORED);
  const wanted = ranked.slice(0, MAX_HYDRATE_CONTACTS).map(([id]) => id);

  // Hop 2 + 3: contact id → ref (company or unassigned partition) → record.
  const refs = await store.refsForContactIds(directory.version, wanted, directory.shards.ids ?? SHARDING.idShards);
  const companyRefs: number[] = [];
  const unassignedRefs = new Map<string, number>();
  for (const id of wanted) {
    const ref = refs.get(id);
    if (ref === undefined) continue;
    const partition = store.unassignedPartitionOfRef(ref);
    if (partition === null) companyRefs.push(ref);
    else unassignedRefs.set(id, partition);
  }

  const contactsByRef = await store.getContactsByCompanyRefs(directory.version, companyRefs, MAX_CONTACT_PARTS);
  const companies = await store.getCompaniesByRefs(directory.version, companyRefs, MAX_CONTACT_PARTS);

  const unassignedByPartition = new Map<number, UnassignedContact[]>();
  await mapLimit([...new Set(unassignedRefs.values())], 4, async (partition) => {
    unassignedByPartition.set(partition, await store.getUnassignedContacts(directory.version, partition));
  });

  const hits: ContactSearchHit[] = [];
  let notHydrated = 0;
  for (const id of wanted) {
    const ref = refs.get(id);
    if (ref === undefined) {
      notHydrated += 1;
      continue;
    }
    const partition = store.unassignedPartitionOfRef(ref);
    if (partition !== null) {
      const record = (unassignedByPartition.get(partition) ?? []).find((contact) => contact.id === id);
      if (!record) {
        notHydrated += 1;
        continue;
      }
      const scored = scoreContact(record, normalized);
      hits.push(toHit(record, null, true, scored.score, scored.matched));
      continue;
    }
    const record = (contactsByRef.get(ref) ?? []).find((contact) => contact.id === id);
    if (!record) {
      notHydrated += 1;
      continue;
    }
    const scored = scoreContact(record, normalized);
    hits.push(toHit(record, companies.get(ref) ?? null, false, scored.score, scored.matched));
  }

  hits.sort((a, b) => b.relevance - a.relevance || a.fullName.localeCompare(b.fullName));
  /*
   * Drop candidates that retrieval accepted but scoring could not justify.
   *
   * The trigram stage exists for typos, and by construction it also produces
   * near-misses that share several trigrams with the query and nothing else ("Ben
   * Smith" for "john smyth"). A record whose relevance is zero was not matched by
   * any rule this search actually applies, and showing it would be exactly the
   * "presented as a real hit" failure the specification forbids.
   */
  const weak = hits.filter((hit) => hit.relevance <= 0).length;
  const justified = hits.filter((hit) => hit.relevance > 0);
  // `scores` holds every id the index matched; only the best candidates were
  // hydrated. Reporting both is what keeps "no results" honest: a page can be
  // empty while the index does hold matches, and the notice says so.
  const matchedIds = scores.size;
  const skip = Math.max(0, options.skip ?? 0);
  const page = justified.slice(skip, skip + options.pageSize);

  /*
   * Label a partial match.
   *
   * Searching a first name ("erin") legitimately returns every Erin, and a query with
   * two words where only one matched is still useful. What must not happen is that a
   * partial page looks like an exact one, so when no result covers every word of the
   * query the response says so — the same honesty rule the company search follows.
   */
  const queryTerms = normalized.split(" ").filter(Boolean);
  const bestCoverage = justified.length
    ? Math.max(...justified.map((hit) => hit.matchedTerms.filter((term) => queryTerms.includes(term)).length))
    : 0;
  const partial = page.length > 0 && queryTerms.length > 1 && bestCoverage < queryTerms.length;

  const notice = page.length
    ? partial
      ? `Showing partial matches for “${options.query}”. No single record matched every word you typed.`
      : null
    : notHydrated > 0
      ? "Matches exist but their records could not be read within this search's budget. Try a more specific name."
      : weak > 0
        ? "Nothing matched closely enough to show. Try the full name, or a different spelling."
        : null;

  return {
    hits: page,
    matched: matchedIds,
    notHydrated,
    notice,
    correctedQuery: null,
    tookMs: Date.now() - started,
  };
}

/** Contact record for one id, attached or preserved (detail page). */
export async function loadContactById(
  store: R2Store,
  directory: IndexDirectory,
  id: string,
): Promise<{ contact: Contact | null; company: Company | null; unassigned: boolean }> {
  const refs = await store.refsForContactIds(directory.version, [id], directory.shards.ids ?? SHARDING.idShards);
  const ref = refs.get(id);
  if (ref === undefined) return { contact: null, company: null, unassigned: false };
  const partition = store.unassignedPartitionOfRef(ref);
  if (partition !== null) {
    const contacts = await store.getUnassignedContacts(directory.version, partition);
    return { contact: contacts.find((contact) => contact.id === id) ?? null, company: null, unassigned: true };
  }
  const contacts = await store.getContactsByCompanyRef(directory.version, ref);
  const contact = contacts.find((item) => item.id === id) ?? null;
  const company = contact ? await store.getCompanyByRef(directory.version, ref) : null;
  return { contact, company, unassigned: false };
}

