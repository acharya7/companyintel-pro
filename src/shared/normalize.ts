/**
 * CompanyIntel — deterministic, versioned name/domain normalizer.
 *
 * THE SAME FILE MUST BE USED BY THE INDEXER, THE WORKER AND THE FRONTEND.
 * Normalization behaviour is part of the index format: if any rule below
 * changes, bump `NORMALIZER_VERSION` so a rebuild is triggered and stale
 * indexes are refused instead of silently returning wrong results.
 *
 * Design notes
 * ------------
 * - We never delete meaningful tokens from the *primary* normalized name.
 *   Legal suffixes are only stripped from the trailing position and only when
 *   at least one other token remains ("Limited Brands" keeps "limited").
 * - Abbreviation expansion and compact (spaceless) forms are produced as
 *   *aliases*, so they widen matching without rewriting the primary key.
 * - Everything is Unicode-safe: NFKD decomposition + combining-mark removal, so
 *   "Nestlé" and "Nestle" normalize identically.
 */

/** Bump whenever any rule in this file changes. */
export const NORMALIZER_VERSION = 1;

/** Trailing tokens that describe legal form rather than identity. */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "lp",
  "ltd",
  "limited",
  "plc",
  "pvt",
  "private",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "srl",
  "spa",
  "bv",
  "nv",
  "ab",
  "as",
  "asa",
  "oy",
  "oyj",
  "aps",
  "pty",
  "pte",
  "sdn",
  "bhd",
  "kk",
  "kg",
  "sl",
  "ltda",
  "sac",
  "sro",
  "zrt",
  "doo",
  "ad",
  "eood",
  "ooo",
  "jsc",
  "ojsc",
  "pjsc",
  "cjsc",
]);

/**
 * Abbreviations expanded into alias forms only. Deliberately conservative:
 * we never expand ambiguous two-letter tokens.
 */
export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  intl: "international",
  svc: "services",
  svcs: "services",
  servs: "services",
  mgmt: "management",
  grp: "group",
  univ: "university",
  govt: "government",
  natl: "national",
  bros: "brothers",
  assoc: "associates",
  engg: "engineering",
  devs: "developers",
  techs: "technologies",
  pharma: "pharmaceuticals",
  labs: "laboratories",
  telecom: "telecommunications",
  infotech: "information technology",
  aeronautics: "aeronautical",
  // Legal forms, canonicalised to their long spelling so "Infosys Ltd" and
  // "Infosys Limited" produce the same alias.
  ltd: "limited",
  inc: "incorporated",
  corp: "corporation",
};

/**
 * Generic terms that describe almost any company. Matching on these alone must
 * be penalised, otherwise a query such as "solutions" returns noise.
 */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "international",
  "solutions",
  "services",
  "service",
  "global",
  "group",
  "holding",
  "holdings",
  "technologies",
  "technology",
  "systems",
  "system",
  "enterprises",
  "enterprise",
  "ventures",
  "partners",
  "industries",
  "industrial",
  "limited",
  "company",
  "corporation",
  "consulting",
  "agency",
  "labs",
  "digital",
]);

/** Remove diacritics: "Nestlé" -> "nestle". */
export function deaccent(input: string): string {
  return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Canonical lowercase token stream.
 *
 * Steps: NFKD → strip diacritics → lowercase → `&`/`+` to " and " → drop
 * apostrophes (so "McDonald's" stays one token) → other punctuation to spaces →
 * collapse whitespace.
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  const text = deaccent(String(input))
    .toLowerCase()
    .replace(/&/g, " and ")
    // Apostrophes and periods are removed rather than spaced, so "O'Brien"
    // stays one token and "Nestlé S.A." yields [nestle, sa] instead of
    // [nestle, s, a]. Every other separator becomes a space.
    .replace(/['’`´.]/g, "")
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, " ")
    .trim();
  return text.length ? text.split(/\s+/).filter(Boolean) : [];
}

/** Strip trailing legal-form tokens while keeping at least one token. */
export function stripLegalSuffixes(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && LEGAL_SUFFIXES.has(out[out.length - 1])) out.pop();
  return out;
}

/**
 * Expand known abbreviations token by token (aliases only).
 *
 * The lookup is own-property-only on purpose. `ABBREVIATIONS` is an object
 * literal, so a plain `ABBREVIATIONS[token]` also finds everything inherited from
 * `Object.prototype`: a company actually called "Constructor" (or "ToString",
 * "ValueOf", …) returned a *function*, and `expansion.split(" ")` then threw
 * `expansion.split is not a function` in the middle of a run — which is exactly
 * what happened to this dataset, 10,000 companies into a real sample pass.
 */
export function expandAbbreviations(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const expansion = Object.prototype.hasOwnProperty.call(ABBREVIATIONS, t) ? ABBREVIATIONS[t] : undefined;
    if (expansion) out.push(...expansion.split(" "));
    else out.push(t);
  }
  return out;
}

/** Collapse all whitespace out of a normalized string. */
export function compact(normalized: string): string {
  return normalized.replace(/\s+/g, "");
}

/**
 * Primary normalization: the key under which a company name is indexed and
 * matched. Deterministic and idempotent (`normalizeName(normalizeName(x)) ===
 * normalizeName(x)`).
 */
export function normalizeName(input: string): string {
  return stripLegalSuffixes(tokenize(input)).join(" ");
}

/** Query normalization is intentionally identical to name normalization. */
export function normalizeQuery(input: string): string {
  return normalizeName(input);
}

/**
 * Every normalized form a name can legitimately be searched by:
 * primary, abbreviation-expanded, legal-suffix-stripped, spaceless-compact and
 * the fully unstripped token stream. Order is stable and duplicates removed.
 */
export function nameVariants(input: string): string[] {
  const tokens = tokenize(input);
  if (!tokens.length) return [];
  const primary = stripLegalSuffixes(tokens).join(" ");
  const candidates = [
    primary,
    tokens.join(" "),
    expandAbbreviations(tokens).join(" "),
    expandAbbreviations(stripLegalSuffixes(tokens)).join(" "),
    compact(primary),
    compact(tokens.join(" ")),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Normalize a website/domain into a bare host: strips scheme, credentials,
 * `www.`, port, path, query and trailing dots.
 *
 * Returns `null` for values that cannot be a host (e.g. "n/a", "").
 */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let value = String(input).trim().toLowerCase();
  if (!value) return null;
  if (/^(n\/?a|none|null|unknown|-|--)$/.test(value)) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^[^@/]*@/, "");
  value = value.split(/[/?#]/)[0];
  value = value.replace(/:\d+$/, "");
  value = value.replace(/^www\./, "");
  value = value.replace(/\.+$/, "");
  if (!value || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return null;
  return value;
}

/** Normalize a LinkedIn URL to its canonical `linkedin.com/<kind>/<slug>` form. */
export function normalizeLinkedin(input?: string | null, kind: "company" | "in" = "company"): string | null {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/linkedin\.[a-z.]+\/(company|in|school|pub)\/([^/?#]+)/);
  if (match) return `linkedin.com/${match[1]}/${match[2].replace(/\/+$/, "")}`;
  const slug = raw.replace(/^.*linkedin\.[a-z.]+\//, "").replace(/[/?#].*$/, "");
  if (!slug) return null;
  return `linkedin.com/${kind}/${slug}`;
}

/** Normalize an email address (lowercase, trimmed) or return null. */
export function normalizeEmail(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim().toLowerCase();
  if (!value || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(value)) return null;
  return value;
}

/** Normalize a phone number into digits only (with a leading + when present). */
export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim();
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 6 || digits.length > 20) return null;
  return value.startsWith("+") ? `+${digits}` : digits;
}

/** Lowercase a free-form attribute, collapsing whitespace; null when empty. */
export function normalizeAttribute(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  const value = deaccent(String(input)).replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/^(n\/?a|none|null|unknown|-|--)$/i.test(value)) return null;
  return value;
}

/**
 * Build the strong identity key used for conservative entity resolution.
 *
 * Priority: normalized domain → canonical LinkedIn company URL → source-provided
 * id → normalized name. Only the first two are treated as *strong* evidence for
 * merging (see `isStrongIdentity`).
 */
export function identityKey(input: {
  domain?: string | null;
  linkedinUrl?: string | null;
  sourceId?: string | null;
  name: string;
}): string {
  const domain = normalizeDomain(input.domain);
  if (domain) return `d:${domain}`;
  const linkedin = normalizeLinkedin(input.linkedinUrl, "company");
  if (linkedin) return `l:${linkedin}`;
  const sourceId = normalizeAttribute(input.sourceId);
  if (sourceId) return `s:${sourceId.toLowerCase()}`;
  return `n:${normalizeName(input.name)}`;
}

/** True when a key represents strong identity evidence (safe for merging). */
export function isStrongIdentity(key: string): boolean {
  return !key.startsWith("n:");
}

/** Fraction of query tokens that are generic — used for query-length-aware scoring. */
export function genericTokenRatio(tokens: string[]): number {
  if (!tokens.length) return 0;
  return tokens.filter((t) => GENERIC_TOKENS.has(t)).length / tokens.length;
}
