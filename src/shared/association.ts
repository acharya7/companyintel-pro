/**
 * Company ↔ contact association: the evidence hierarchy, and the one function
 * that decides it.
 *
 * ## Why this module exists
 *
 * Pass 1 spools every source row with a *claimed* company (the company name the
 * row itself carried) and the company identifiers on that row. Resolving company
 * identity (Stage A) answers "which company is this row about?"; it does NOT
 * answer "does this person actually work there?". Those were the same question
 * while both were derived from one normalized NAME, which is exactly how
 * millions of people could be attached to the wrong company of a shared name.
 *
 * Stage B asks the second question on its own, per contact, against every
 * credible company record in that name family, and answers with one of four
 * categories — never with a confidence *percentage*, because nothing here is
 * calibrated against employment ground truth.
 *
 * ## The categories (Section 5 / Section 6 of the specification)
 *
 *   high_confidence — evidence independent of the name join supports ONE company:
 *                     the record itself carries the employer's identity
 *                     (`row_carries_employer_identity` — a corporate domain,
 *                     website, source organization id or company LinkedIn page on
 *                     the same row), or the contact's email domain matches that
 *                     one company (`email_domain_matches_*`, which includes a
 *                     branch/subsidiary host under the company's domain).
 *   plausible       — evidence favours one company but does not verify it: a name
 *                     family with a single member (nothing to confuse it with),
 *                     country evidence that fits exactly the assigned company,
 *                     or a family where exactly one member carries any identity
 *                     at all.
 *   unresolved      — the family has several credible members and nothing
 *                     distinguishes them (or the evidence fits several). The
 *                     contact is NOT attached to any company; it is preserved
 *                     under the name it claimed, for review.
 *   conflicting     — positive evidence points AWAY from the claimed company and
 *                     cannot be turned into a safe reassignment: the contact's
 *                     corporate email domain matches no member of the family
 *                     while the family has domains, the email domain matches
 *                     another member but the record itself identifies the claimed
 *                     one, or the country identifies another member. Always
 *                     reported as disputed, never as a verified employee.
 *
 * ## What is deliberately NOT evidence
 *
 *   - a public email provider (gmail.com, yahoo.com, outlook.com, …) — a person
 *     with a personal address says nothing about their employer;
 *   - name similarity, or a shared normalized name, on its own;
 *   - the order a company appeared in the dataset (there is no "first one wins");
 *   - a person's own LinkedIn profile URL (see Section 5);
 *   - a country difference on its own: people work away from headquarters, so a
 *     country mismatch only becomes evidence when it singles out *another*
 *     company of the same name.
 *
 * Moving a contact is only allowed when independent evidence names a different
 * *specific* company than the one the row identified: an email-domain match
 * (`email_domain_matches_other_company_of_same_name`) or the family containing
 * exactly one credible entity. Country evidence is used to *flag*, never to
 * relocate: it is a weaker signal and a wrong relocation is worse than a flagged
 * one. A row that identified no employer at all (`NO_CLAIM_REF`) has nothing to
 * move away from, so it is identified by its own evidence instead.
 *
 * ## Privacy and purity
 *
 * This module is pure and runtime-neutral: no I/O, no Node APIs, no logging. It
 * receives an email address only to compare its DOMAIN, and never returns an
 * email, phone number or profile URL in its verdict.
 */

import { normalizeDomain } from "./normalize";

/** The four association categories, strongest evidence first. */
export type AssociationCategory = "high_confidence" | "plausible" | "unresolved" | "conflicting";

export const ASSOCIATION_CATEGORIES: readonly AssociationCategory[] = [
  "high_confidence",
  "plausible",
  "unresolved",
  "conflicting",
] as const;

/** Short labels for the interface — one source of truth for every screen. */
export const ASSOCIATION_CATEGORY_LABELS: Record<AssociationCategory, string> = {
  high_confidence: "Verified evidence",
  plausible: "Possible match",
  unresolved: "Employer unresolved",
  conflicting: "Disputed employer",
};

/** One-line description of what each category means, shown next to the label. */
export const ASSOCIATION_CATEGORY_HINTS: Record<AssociationCategory, string> = {
  high_confidence: "Independent evidence (employer identity on the source record, or a matching corporate email domain).",
  plausible: "Evidence favours this company but does not verify the relationship.",
  unresolved: "Several companies of this name remain possible, so no company is claimed.",
  conflicting: "Evidence contradicts the claimed employer; shown for review, never as verified.",
};

/**
 * Why a contact got its category. The suffix `reason` is stored in the index and
 * reported by the audit, so every verdict can be explained after the fact.
 */
export type AssociationReason =
  | "row_carries_employer_identity"
  | "email_domain_matches_assigned_company"
  | "email_domain_matches_other_company_of_same_name"
  | "email_domain_outside_name_family"
  | "email_domain_conflicts_with_row_identity"
  | "unique_name"
  | "country_supports_assigned_company"
  | "country_identifies_company"
  | "country_points_to_other_company_of_same_name"
  | "single_strong_candidate"
  | "several_candidates_remain"
  | "no_credible_candidate";

/** How the email domain of the contact relates to the company family. */
export type DomainVerdict = "match" | "sibling" | "outside_family" | "public_provider" | "absent" | "ambiguous";

/** How the contact's country relates to the family. */
export type CountryVerdict = "selects" | "supports" | "differ" | "ambiguous" | "absent";

/** Everything the decision used, recorded so a verdict can be re-checked. */
export interface AssociationEvidence {
  /** `shared` when more than one company record carries this normalized name. */
  name: "unique" | "shared";
  domain: DomainVerdict;
  country: CountryVerdict;
  /** True when the source row itself carried the employer's identity. */
  rowIdentity: boolean;
  /** Company records considered in this name family. */
  candidates: number;
}

/**
 * How many candidate ids are stored on one association record.
 *
 * A shared name can have thousands of members (a national brand, or a name like
 * "Delta"), and an unresolved contact used to store *every* candidate: on the
 * benchmark's largest families that is thousands of ids per contact, which is index
 * bloat and exceeds the API schema's own bound. The review needs to know how many
 * candidates remained and which a few of them were, not all of them, so the stored
 * list is capped and the true number is kept in `candidateCount`. The cap is
 * deterministic (the same candidates in the same order every run), so the record is
 * still reproducible.
 */
export const MAX_CANDIDATE_IDS = 8;

/** The stored verdict. `category` is the only field the UI must understand. */
export interface AssociationRecord {
  category: AssociationCategory;
  reason: AssociationReason;
  evidence: AssociationEvidence;
  /**
   * Up to `MAX_CANDIDATE_IDS` company ids that were genuinely possible when the
   * family was ambiguous — a sample for review, not the full set.
   */
  candidateCompanyIds?: string[];
  /**
   * How many candidates there really were (`candidateCompanyIds.length` when it is
   * below the cap). Absent when the decision was not about a live choice between
   * candidates — for example a domain match, where exactly one company was possible.
   */
  candidateCount?: number;
}

/** One company record that a contact could belong to, within its name family. */
export interface AssociationCandidate {
  /** Document ref inside the partition (used to attach the contact). */
  ref: number;
  /** Canonical company id (`c_…`), stable across runs. */
  id: string;
  name: string;
  normalizedName: string;
  /** Verified corporate domain, normalized (no scheme, no `www`). */
  domain: string | null;
  linkedinUrl: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  /** True when the record carries any identity beyond its name. */
  hasStrongIdentity: boolean;
}

/** The contact fields the decision is allowed to use. */
export interface AssociationContactInput {
  email?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
}

export interface AssociateInput {
  contact: AssociationContactInput;
  /**
   * The company record the row's own company name resolved to (the claim), or
   * `NO_CLAIM_REF` when the row carried no employer identifier at all.
   *
   * A row whose only company field is a NAME has no employer claim to defend: the
   * resolver's ref is merely the record that owns the shared name key, i.e. the
   * first company of that name in the input. Judging the contact against that
   * arbitrary member made the same row "plausible" in one file order and
   * "conflicting" in another (and attached it to a company its evidence never
   * named). Callers therefore pass this sentinel, which is never a candidate, and
   * Stage B decides from the contact's own evidence instead.
   */
  claimedRef: number;
  /**
   * True when the source row itself carried a company identifier (domain,
   * website, organization id or company LinkedIn page). That identity is
   * *record-provided*: it is not externally verified, and the audit reports
   * high-confidence contacts split by reason so this distinction stays visible.
   */
  claimedIdentity: boolean;
  /**
   * Every CREDIBLE company record in the claimed normalized-name family — the
   * records that carry some identity beyond their name.
   *
   * A name-only record of the same name is deliberately left out when at least one
   * credible record exists: attaching a person to a name-only placeholder would
   * present a company that carries no verifiable identity as their employer. When
   * the whole family is name-only, the placeholders *are* the family and are passed
   * in (there is nothing better to compare against). `claimedRef` may therefore be
   * absent from `candidates`; that is the "the claim itself is a placeholder" case,
   * and no verdict below calls the claim a contradiction in it.
   */
  candidates: AssociationCandidate[];
}

export interface AssociationDecision {
  category: AssociationCategory;
  reason: AssociationReason;
  /** Company ref the contact is attached to, or `null` when unresolved. */
  assignedRef: number | null;
  /** True when the contact moved away from the company it claimed. */
  moved: boolean;
  /** Company ids that remain plausible, for review of an ambiguous verdict. */
  candidateCompanyIds?: string[];
  record: AssociationRecord;
}

/**
 * `claimedRef` value for a contact row that carried no employer identity.
 *
 * Negative so it can never collide with a document ref. Stage B treats it as "no
 * claim": the row's company name is a name, not an employer, and only the
 * contact's own evidence (email domain, country, family size) may attach it.
 */
export const NO_CLAIM_REF = -1;

/* -------------------------------------------------------------------------- */
/* Email-domain evidence                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Public mailbox providers. An address here is a personal address: it can never
 * confirm a corporate employer, and it can never contradict one either — that is
 * what makes it *not evidence* rather than negative evidence.
 *
 * Deliberately a list of registrable domains plus a suffix rule, not a heuristic
 * ("has a hyphen", "is short"): a heuristic would silently classify real company
 * domains as personal, and every contact at such a company would lose its
 * strongest signal.
 */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "outlook.com",
  "outlook.fr",
  "live.com",
  "live.co.uk",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "rediffmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hanmail.net",
  "orange.fr",
  "wanadoo.fr",
  "laposte.net",
  "free.fr",
  "web.de",
  "t-online.de",
  "comcast.net",
  "verizon.net",
  "sbcglobal.net",
  "bellsouth.net",
  "att.net",
  "cox.net",
  "charter.net",
  "shaw.ca",
  "rogers.com",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "bigpond.com",
  "optusnet.com.au",
];

const PUBLIC_EMAIL_SET = new Set(PUBLIC_EMAIL_DOMAINS);

/** True when an email host is a personal mailbox provider, not an employer. */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return PUBLIC_EMAIL_SET.has(domain);
}

/** Normalized host of an email address, or `null` when there is none. */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const host = normalizeDomain(email.slice(at + 1));
  return host || null;
}

/**
 * True when two hosts are the same domain or one is a parent of the other.
 *
 * This is a symmetric "same organisation domain family" question, used by the
 * read-only audit. It is deliberately NOT what decides a branch match below: for
 * an employer decision the direction matters (see `isBranchOf`).
 */
export function sameDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * True when `host` is `parent` or a host UNDER it — a branch mailbox of that
 * company, not its parent.
 *
 * DIRECTION IS THE WHOLE POINT. `mail.acme.com` under the company domain
 * `acme.com` is a branch of that company, so it is supporting evidence. The
 * reverse is not: a person at `acme.com` is not thereby an employee of a company
 * whose recorded domain is `logistics.acme.com` — they may well work at the
 * parent group. The symmetric `sameDomain` used to be applied here, which marked
 * exactly that case `high_confidence` at the subsidiary. A group/parent domain is
 * now "outside the family" and is reported as a conflict (or stays unresolved),
 * never as verified employment.
 */
export function isBranchOf(host: string | null | undefined, parent: string | null | undefined): boolean {
  if (!host || !parent) return false;
  return host === parent || host.endsWith(`.${parent}`);
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

function emptyEvidence(name: "unique" | "shared"): AssociationEvidence {
  return { name, domain: "absent", country: "absent", rowIdentity: false, candidates: 1 };
}

/**
 * Decide one contact's association.
 *
 * Deterministic and order-independent: candidates are compared by evidence, never
 * by their position, and `Array.prototype.filter` preserves the caller's order but
 * nothing in this function reads an index. Two candidates with identical evidence
 * produce `unresolved` — never "the first one".
 */
export function associateContact(input: AssociateInput): AssociationDecision {
  const candidates = input.candidates;
  const claimed = candidates.find((candidate) => candidate.ref === input.claimedRef) ?? null;
  const shared = candidates.length > 1;
  /** Evidence about the row can only accuse a claim that exists and carries identity. */
  const claimIsCredible = Boolean(claimed) && input.claimedIdentity;

  const domain = emailDomainOf(input.contact.email);
  const publicProvider = isPublicEmailDomain(domain);
  const corporateDomain = domain && !publicProvider ? domain : null;
  const familyHasDomain = candidates.some((candidate) => Boolean(candidate.domain));
  const contactCountry = input.contact.country ?? null;
  const familyHasCountry = candidates.some((candidate) => Boolean(candidate.country));

  const { exact, related } = corporateDomain ? domainTiers(corporateDomain, candidates) : { exact: [] as AssociationCandidate[], related: [] as AssociationCandidate[] };
  const domainSelector = exact.length === 1 ? exact[0] : exact.length === 0 && related.length === 1 ? related[0] : null;
  const domainAmbiguous = exact.length > 1 || (exact.length === 0 && related.length > 1);

  const domainVerdict: DomainVerdict = !domain
    ? "absent"
    : publicProvider
      ? "public_provider"
      : domainSelector
        ? (exact.length === 1 ? "match" : "sibling")
        : domainAmbiguous
          ? "ambiguous"
          : familyHasDomain
            ? "outside_family"
            : "absent";

  const countryMatches = contactCountry ? candidates.filter((candidate) => candidate.country === contactCountry) : [];
  const countryVerdict: CountryVerdict =
    !contactCountry || !familyHasCountry
      ? "absent"
      : countryMatches.length === 1
        ? countryMatches[0].ref === input.claimedRef
          ? "supports"
          : "selects"
        : countryMatches.length === 0
          ? "differ"
          : "ambiguous";

  const credible = candidates.filter((candidate) => candidate.hasStrongIdentity);
  const evidence: AssociationEvidence = {
    name: shared ? "shared" : "unique",
    domain: domainVerdict,
    country: countryVerdict,
    rowIdentity: input.claimedIdentity,
    candidates: candidates.length,
  };

  const decide = (
    category: AssociationCategory,
    reason: AssociationReason,
    assignedRef: number | null,
    moved = false,
    candidateCompanyIds?: string[],
  ): AssociationDecision => ({
    category,
    reason,
    assignedRef,
    moved,
    candidateCompanyIds,
    record: {
      category,
      reason,
      evidence,
      // The STORED record keeps a bounded sample plus the real count; the decision
      // returned to the caller keeps the full list, because the caller needs every
      // candidate id to write contact counts — it is the index that must stay small.
      ...(candidateCompanyIds && candidateCompanyIds.length
        ? { candidateCompanyIds: candidateCompanyIds.slice(0, MAX_CANDIDATE_IDS), candidateCount: candidateCompanyIds.length }
        : {}),
    },
  });

  /* 1. The record itself identified the employer (strongest, but record-provided). */

  if (claimIsCredible && claimed) {
    if (domainSelector && domainSelector.ref !== claimed.ref) {
      // The row names one company and the person's own address names another of
      // the same name. Two signals, two answers — do not pick one silently.
      return decide("conflicting", "email_domain_conflicts_with_row_identity", claimed.ref, false, [domainSelector.id]);
    }
    if (corporateDomain && !domainSelector && domainVerdict === "outside_family") {
      return decide("conflicting", "email_domain_outside_name_family", claimed.ref, false, candidates.map((candidate) => candidate.id));
    }
    return decide("high_confidence", "row_carries_employer_identity", claimed.ref);
  }

  /*
   * 2. No record-provided identity: an email-domain match is the strongest link.
   *    A match on another company of the same name is a reassignment, and it is
   *    only a "move" from a claim that carried identity of its own.
   */

  if (domainSelector) {
    // `moved` means "attached somewhere other than the employer this row claimed".
    // A name-only row (no claim) is being identified, not reassigned, so it has no
    // move to record — inventing one would attribute the person to a company their
    // own row never named.
    const moving = Boolean(claimed) && domainSelector.ref !== input.claimedRef;
    return decide(
      "high_confidence",
      !claimed || domainSelector.ref === input.claimedRef ? "email_domain_matches_assigned_company" : "email_domain_matches_other_company_of_same_name",
      domainSelector.ref,
      moving,
      [domainSelector.id],
    );
  }

  /*
   * 3. A corporate domain that matches nobody in the family: evidence away from
   *    the employer the row identified. This is the same contradiction the
   *    read-only audit reports (`email_domain_contradicts_assigned_company`); it is
   *    not turned into a relocation either (a contractor or subsidiary domain is
   *    not proof of a different employer, so the contact keeps its claim and the
   *    disagreement is recorded). A row with no employer identity at all has no
   *    claim to accuse, so this branch cannot fire for it.
   */

  if (claimed && corporateDomain && domainVerdict === "outside_family") {
    return decide("conflicting", "email_domain_outside_name_family", claimed.ref, false, candidates.map((candidate) => candidate.id));
  }

  /* 4. The family has exactly one member: there is nothing to confuse it with. */

  if (!shared && claimed) {
    return decide("plausible", "unique_name", claimed.ref);
  }

  /*
   * 5. Country evidence.
   *
   *    Country never overrides a record-provided identity, and on its own it never
   *    relocates a person (people work away from headquarters). Two roles are left:
   *    it can flag a credible claim as disputed, or it can identify the employer
   *    when the row carried no employer identity at all (`NO_CLAIM_REF`) — where
   *    the alternative is not a different employer but limbo.
   */

  if (countryVerdict === "selects" && !claimIsCredible) {
    if (!claimed) {
      const target = countryMatches[0];
      return decide("plausible", "country_identifies_company", target.ref, false, [target.id]);
    }
    return decide("conflicting", "country_points_to_other_company_of_same_name", claimed.ref, false, countryMatches.map((candidate) => candidate.id));
  }

  if (countryVerdict === "supports" && claimed) {
    return decide("plausible", "country_supports_assigned_company", claimed.ref);
  }

  if (credible.length === 1) {
    const only = credible[0];
    return only.ref === input.claimedRef
      ? decide("plausible", "single_strong_candidate", only.ref)
      : decide("plausible", "single_strong_candidate", only.ref, false, [only.id]);
  }

  if (credible.length === 0) {
    // Every member is a name-only record: there is no credible entity to choose,
    // but the family itself is still the best available answer (and stays
    // plausible, never verified). The fallback must be a real candidate — the
    // no-claim sentinel is not attachable.
    const fallback = claimed ?? candidates[0] ?? null;
    return fallback
      ? decide("plausible", "no_credible_candidate", fallback.ref)
      : decide("unresolved", "no_credible_candidate", null);
  }

  // Several credible members and nothing that separates them.
  return decide("unresolved", "several_candidates_remain", null, false, credible.map((candidate) => candidate.id));
}

/** Exact-host matches and parent/branch matches, kept apart so exact wins. */
function domainTiers(domain: string, candidates: AssociationCandidate[]): { exact: AssociationCandidate[]; related: AssociationCandidate[] } {
  const exact: AssociationCandidate[] = [];
  const related: AssociationCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.domain) continue;
    if (candidate.domain === domain) exact.push(candidate);
    // Only a host UNDER the company's domain is a branch of it (see `isBranchOf`).
    else if (isBranchOf(domain, candidate.domain)) related.push(candidate);
  }
  return { exact, related };
}

/**
 * Map an index category onto the read-only audit's class names.
 *
 * The audit predates the index categories and reports `confirmed` / `conflict`;
 * keeping the mapping in one function is what lets the audit reconcile what the
 * indexer decided with what an independent read of the same evidence concludes,
 * instead of comparing two vocabularies by eye.
 */
export function auditClassForCategory(category: AssociationCategory): "confirmed" | "plausible" | "unresolved" | "conflict" {
  if (category === "high_confidence") return "confirmed";
  if (category === "conflicting") return "conflict";
  return category;
}

/** True when a company profile may present this contact as a real employee. */
export function isTrustedAssociation(category: AssociationCategory | undefined): boolean {
  return category === undefined || category === "high_confidence" || category === "plausible";
}

/**
 * Does one contact satisfy an association-category filter?
 *
 * A contact with **no** recorded category (a format-v2 index) matches every
 * filter: the categories did not exist when that index was written, so the filter
 * is inert rather than an empty result set nobody can explain. The same rule is
 * what keeps a v2 dataset fully usable after the format upgrade.
 */
export function associationMatchesFilter(
  category: AssociationCategory | undefined,
  wanted: readonly AssociationCategory[] | undefined,
): boolean {
  if (!wanted?.length || category === undefined) return true;
  return wanted.includes(category);
}

export { emptyEvidence as emptyAssociationEvidence };

/** Category of a stored record, or `undefined` when it predates categories. */
export function associationCategoryOf(record: { category: AssociationCategory } | undefined): AssociationCategory | undefined {
  return record?.category;
}
