/**
 * Contact phone numbers: extraction, display and `tel:` links.
 *
 * WHY THIS IS A SHARED MODULE
 * ---------------------------
 * The same rule has to hold in the indexer, the Worker and the browser:
 *
 *   - a number is shown exactly as the source row carried it (country code and
 *     extension included), never reformatted into a different number;
 *   - a mobile column and a landline column stay separate when the source names
 *     them separately;
 *   - several distinct numbers on one record are all kept, and an identical
 *     number is never listed twice;
 *   - a value that is not plausibly a phone number (an id, a score, a date, a
 *     postal code) is never presented as one.
 *
 * Source headers vary (`phone`, `person_phone`, `mobile`, `telephone`,
 * `work_phone`, `contact_number`, …), so headers are classified by name and the
 * values are validated. Nothing is inferred: if no phone-like column carries a
 * value, the contact simply has no number.
 */

/** A phone-like column in a source record. */
export type PhoneKind = "phone" | "mobile";

/** Headers that must never be read as a phone number. */
const NOT_PHONE = /(fax|geojson|linkedin|postal|score|rank|count|percent|id$|url|extension$)/i;

/** Mobile/cell tokens, tested on a compacted header so `cell_phone` matches. */
const MOBILE_TOKEN = /(mobile|mobileno|mobilenumber|mob|cell|cellular|gsm)/i;
/** Landline/work phone tokens, likewise on `contact_number` and `direct_phone`. */
const PHONE_TOKEN = /(phone|telephone|telnumber|^tel$|contactnumber|worknumber|businessnumber|directdial|directnumber)/i;

/** Split a cell that carries more than one number. */
const VALUE_SEPARATOR = /\s*(?:[;|]|\n|\r\n|\s+\/\s+|\s+or\s+)\s*/i;

/**
 * Classify one source header. `null` means "not a phone column".
 *
 * `person_phone`, `person_sanitized_phone`, `organization_phone`, `work_phone`
 * and `mobile` are the real-world shapes this must accept; `person_num_...`,
 * `fax`, `ext`, `_id` and location/postal columns are explicitly refused.
 */
export function phoneKindOfHeader(header: string): PhoneKind | null {
  const text = String(header ?? "").trim();
  if (!text || NOT_PHONE.test(text)) return null;
  // Compact the separators first: exports use `contact_number`, `direct_phone`
  // and `mobile_number` as often as they use a single word.
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (MOBILE_TOKEN.test(compact)) return "mobile";
  if (PHONE_TOKEN.test(compact)) return "phone";
  return null;
}

/** Digits only, for comparison and `tel:` links. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Split a trailing extension off a value.
 *
 * `+1 (503) 443-7070 ext. 42`, `… x42` and `… #42` all keep the extension; it is
 * never folded into the main number, because doing that changes the number.
 */
export function splitPhoneExtension(value: string): { base: string; extension: string | null } {
  const text = String(value ?? "").trim();
  const match = /^(.*\d)\s*(?:ext\.?|extension|x|#)\s*(\d{1,6})$/i.exec(text);
  if (!match) return { base: text, extension: null };
  const base = match[1].trim();
  // `x` is only an extension marker when what precedes it is a complete number.
  if (!base || phoneDigits(base).length < 6) return { base: text, extension: null };
  return { base, extension: match[2] };
}

/**
 * True when a cell can honestly be displayed as a telephone number.
 *
 * Deliberately conservative: 7–15 digits (E.164's ceiling) after the extension is
 * removed, no words, no dates, and no long unformatted numeric identifier.
 */
export function isPlausiblePhone(value: string): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/^(n\/?a|none|null|unknown|—|-+|\.+)$/i.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(text)) return false;
  const { base } = splitPhoneExtension(text);
  // Letters are only allowed in an extension or a `tel:` prefix; a name or note
  // that happens to contain digits is not a phone number.
  const withoutExtension = base.replace(/^tel:/i, "");
  if (/[a-z]/i.test(withoutExtension)) return false;
  if (!/^[+()\d][\d\s().+\-/]*$/.test(withoutExtension)) return false;
  const digits = phoneDigits(withoutExtension);
  if (digits.length < 7 || digits.length > 15) return false;
  // A bare long integer is far more likely to be an account id than a phone
  // number; real exports include punctuation or a country-code prefix.
  if (/^\d+$/.test(withoutExtension.trim()) && digits.length > 12) return false;
  return true;
}

/** Split one cell into its valid, distinct numbers. */
export function splitPhoneValues(value: string): string[] {
  return String(value ?? "")
    .split(VALUE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => isPlausiblePhone(part));
}

/** A duplicate key that ignores formatting but keeps an extension distinct. */
function numberKey(value: string): string {
  const { base, extension } = splitPhoneExtension(value);
  const digits = phoneDigits(base).replace(/^0+/, "");
  return `${digits}${extension ? `x${extension}` : ""}`;
}

/** Prefer the formatted value when the same number appears twice. */
function preferDisplay(current: string, candidate: string): string {
  if (current === candidate) return current;
  const currentPlain = /^[+\d]+$/.test(current);
  const candidatePlain = /^[+\d]+$/.test(candidate);
  if (currentPlain && !candidatePlain) return candidate;
  return current;
}

export interface PhoneNumbers {
  /** Work/landline number, as carried by the source. */
  phone: string | null;
  /** Mobile/cell number, when the source identifies one separately. */
  mobile: string | null;
  /** Further distinct numbers on the same record. */
  additional: string[];
  /** Every number, phone first, mobile second, then the rest. */
  all: string[];
}

interface PhoneCandidate {
  value: string;
  kind: PhoneKind;
}

/**
 * Collect every phone number a record carries.
 *
 * Canonical `phone`/`mobile` values are considered first; then every attribute
 * whose header is phone-like. This is what lets an already-published index expose
 * original fields (`person_phone`, `person_mobile`) that the canonical projection
 * did not map, without rebuilding the index.
 */
export function extractPhoneNumbers(source: {
  phone?: string | null;
  mobile?: string | null;
  attributes?: Record<string, string> | null;
}): PhoneNumbers {
  const candidates: PhoneCandidate[] = [];

  const push = (value: string | null | undefined, kind: PhoneKind) => {
    if (!value) return;
    for (const number of splitPhoneValues(String(value))) {
      candidates.push({ value: number, kind });
    }
  };

  push(source.phone, "phone");
  push(source.mobile, "mobile");
  for (const [header, value] of Object.entries(source.attributes ?? {})) {
    const kind = phoneKindOfHeader(header);
    if (!kind || !value) continue;
    push(value, kind);
  }

  // Deduplicate, keeping the mobile classification when a number appears in both
  // a mobile and a landline column (the source explicitly said mobile).
  const byKey = new Map<string, PhoneCandidate>();
  for (const candidate of candidates) {
    const key = numberKey(candidate.value);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    byKey.set(key, {
      value: preferDisplay(existing.value, candidate.value),
      kind: existing.kind === "mobile" || candidate.kind === "mobile" ? "mobile" : "phone",
    });
  }

  const ordered = [...byKey.values()];
  const mobile = ordered.find((candidate) => candidate.kind === "mobile")?.value ?? null;
  const phone = ordered.find((candidate) => candidate.kind === "phone")?.value ?? null;
  const additional = ordered
    .filter((candidate) => candidate.value !== phone && candidate.value !== mobile)
    .map((candidate) => candidate.value);

  return {
    phone,
    mobile: mobile === phone ? null : mobile,
    additional,
    all: [phone, mobile, ...additional].filter((value): value is string => Boolean(value)),
  };
}

/**
 * `tel:` link for a display value, or `null` when the value is not a number.
 *
 * The display value is preserved separately; this only builds the href, keeping
 * the country code and passing an extension through as `;ext=`.
 */
export function telHref(value: string | null | undefined): string | null {
  if (!value || !isPlausiblePhone(value)) return null;
  const { base, extension } = splitPhoneExtension(value);
  const trimmed = base.trim();
  let digits = phoneDigits(trimmed);
  if (!digits) return null;
  const international = trimmed.startsWith("+") || trimmed.startsWith("00");
  if (trimmed.startsWith("00")) digits = digits.replace(/^00/, "");
  return `tel:${international ? "+" : ""}${digits}${extension ? `;ext=${extension}` : ""}`;
}

/**
 * The contact fields the UI should render: canonical values first, then anything
 * recoverable from the stored source attributes.
 *
 * `mobile` is returned separately so a record with both a switchboard/landline
 * number and a mobile number never collapses into one ambiguous value.
 */
export function contactPhoneNumbers(contact: {
  phone?: string | null;
  mobile?: string | null;
  attributes?: Record<string, string> | null;
}): PhoneNumbers {
  return extractPhoneNumbers(contact);
}
