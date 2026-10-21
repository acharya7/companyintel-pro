/**
 * Company ↔ contact association audit — pure analysis.
 *
 * ## Why this is a separate concern from `sample-report.mjs`
 *
 * The indexer associates a person row with a company by *normalized company
 * name* when neither file carries a company identifier. That join is the single
 * largest accuracy risk in the product: two different companies can normalize to
 * the same name ("Delta Systems" / "Delta Ltd" → `delta`), and a name-only match
 * is not evidence that a row belongs to that company. `sample-report.mjs` counts
 * the shape of the risk; this module classifies each association *by the evidence
 * that supports it*, so an operator can tell a verified association from an
 * unresolved one before a full production index is built from the same rules.
 *
 * ## The classes, and what "confirmed" is allowed to mean
 *
 *   confirmed   — the association is supported by evidence *independent of the
 *                 name join*: the contact's email domain is the company's domain,
 *                 or it is the domain of exactly one member of a shared-name
 *                 family and that member is the one the contact is attached to.
 *   plausible   — the name join is unique (no family), so there is nothing to
 *                 confuse it with, or a shared-name family leaves exactly one
 *                 candidate consistent with the available evidence. Not proof:
 *                 reported as plausible, never as verified.
 *   unresolved  — a shared-name family with no evidence that separates its
 *                 members (or evidence that fits several of them). The index
 *                 cannot decide; pretending it can would be a fabricated match.
 *   conflict    — the available evidence points *away* from the company the
 *                 contact is currently attached to: the email domain belongs to a
 *                 different family member, or the contact's country identifies a
 *                 different one.
 *
 * A normalized-name match alone NEVER yields `confirmed` — that is the rule the
 * specification calls out explicitly, and `tests/association-audit.test.ts`
 * asserts it.
 *
 * ## What this audit deliberately does not do
 *
 * It never reassigns a contact, rewrites an index object or edits a source file.
 * It reports. Reassignment needs evidence the index does not hold (see
 * `limitations`), so inventing an assignment here would swap one unknown for a
 * wrong answer.
 *
 * ## Privacy
 *
 * Only counts and company-level identifiers (company id / name, family size) are
 * returned. No contact name, email, phone or LinkedIn URL is copied into the
 * report, and nothing is written to disk.
 */

import { normalizeDomain } from "../../src/shared/normalize.ts";

/** The four association classes, strongest evidence first. */
export const ASSOCIATION_CLASSES = ["confirmed", "plausible", "unresolved", "conflict"];

/** Domain evidence of one contact against its company. */
export const DOMAIN_EVIDENCE = ["match", "mismatch", "absent"];

/** How many members of one family the report keeps (memory bound). */
const MAX_FAMILY_MEMBERS = 12;

/**
 * The categories a format-v3 index stores on each contact (see
 * `src/shared/association.ts`). A format-v2 index stores none of them, which the
 * audit reports as `unclassified` rather than assuming the best case.
 */
export const STORED_CATEGORIES = ["high_confidence", "plausible", "unresolved", "conflicting"];

/**
 * Which kind of evidence a stored `reason` rests on.
 *
 * Section 11 asks for "domain evidence" and "source identifiers" separately; the
 * index stores one `reason` per contact, so this table is the single place the
 * mapping lives. `record_identity` means the source row itself carried the
 * employer's identifier (domain, website, LinkedIn page or scoped organization
 * id) — the strongest thing the index can know, but still record-provided rather
 * than independently verified employment.
 */
export const REASON_BASIS = {
  row_carries_employer_identity: "record_identity",
  email_domain_matches_assigned_company: "domain",
  email_domain_matches_other_company_of_same_name: "domain",
  email_domain_outside_name_family: "domain_contradiction",
  email_domain_conflicts_with_row_identity: "domain_contradiction",
  unique_name: "name",
  country_supports_assigned_company: "country",
  country_identifies_company: "country",
  country_points_to_other_company_of_same_name: "country_contradiction",
  single_strong_candidate: "name",
  several_candidates_remain: "name",
  no_credible_candidate: "name",
};

/**
 * Registrable-ish label of a domain? No — the host itself is what we compare.
 * Kept tiny and local so the audit has no dependency on the Worker code.
 */
export function emailDomain(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** True when two hosts are the same domain or one is a subdomain of the other. */
export function sameDomain(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function domainEvidenceFor(company, contact) {
  const companyDomain = normalizeDomain(company.domain);
  const contactDomain = emailDomain(contact.email);
  if (!companyDomain || !contactDomain) return { verdict: "absent", companyDomain, contactDomain };
  return {
    verdict: sameDomain(companyDomain, contactDomain) ? "match" : "mismatch",
    companyDomain,
    contactDomain,
  };
}

/**
 * Build the shared-name families.
 *
 * One record per distinct normalized name; members are materialized only for a
 * name that occurs more than once, and a family keeps at most
 * `MAX_FAMILY_MEMBERS` members (the count is always exact). Memory is therefore
 * bounded by the number of distinct names, not by the number of companies.
 */
export function buildFamilies(companies) {
  const counts = new Map();
  const members = new Map();
  for (const { ref, company } of companies) {
    const name = company.normalizedName ?? "";
    if (!name) continue;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count === 2) {
      // The first member is re-read from the recorded first-of-name below; this
      // keeps a singleton to one map entry.
      const first = members.get(name);
      const list = first ? [first] : [];
      members.set(name, list);
    }
    const list = members.get(name);
    if (list && list.length < MAX_FAMILY_MEMBERS) {
      list.push({
        ref,
        id: company.id,
        domain: normalizeDomain(company.domain),
        country: company.country ?? null,
        city: company.city ?? null,
        hasLinkedin: Boolean(company.linkedinUrl),
      });
    } else if (!list && count === 1) {
      // Remember the first member of a name that may turn out to be a family.
      members.set(name, {
        ref,
        id: company.id,
        domain: normalizeDomain(company.domain),
        country: company.country ?? null,
        city: company.city ?? null,
        hasLinkedin: Boolean(company.linkedinUrl),
      });
    }
  }

  const families = new Map();
  for (const [name, value] of members) {
    if (Array.isArray(value) && (counts.get(name) ?? 0) > 1) families.set(name, value);
  }
  return { counts, families };
}

/**
 * Classify one contact → company association.
 *
 * `family` is the member list for the company's normalized name (length 1 when
 * the name is unique). Everything returned is evidence, never a fabricated
 * verdict: `gap` names what is missing when the class is `unresolved`.
 */
export function classifyAssociation({ company, contact, family }) {
  const domain = domainEvidenceFor(company, contact);
  const shared = family.length > 1;
  const others = shared ? family.filter((member) => member.id !== company.id) : [];
  const companyCountry = company.country ?? null;
  const contactCountry = contact.country ?? null;
  const countryVerdict = !contactCountry || !companyCountry ? "absent" : contactCountry === companyCountry ? "match" : "mismatch";

  // Independent evidence first: a matching email domain is identity, not a name.
  if (domain.verdict === "match") {
    return {
      klass: "confirmed",
      reason: "email_domain_matches_assigned_company",
      evidence: { name: shared ? "shared" : "unique", domain: "match", country: countryVerdict },
    };
  }

  const domainOfAnother = shared && domain.contactDomain
    ? others.filter((member) => member.domain && sameDomain(domain.contactDomain, member.domain))
    : [];
  if (domain.verdict === "mismatch" || domainOfAnother.length > 0) {
    return {
      klass: "conflict",
      reason: domainOfAnother.length > 0 ? "email_domain_belongs_to_another_company_of_the_same_name" : "email_domain_contradicts_assigned_company",
      evidence: { name: shared ? "shared" : "unique", domain: "mismatch", country: countryVerdict },
      alternateCompanyIds: domainOfAnother.map((member) => member.id),
    };
  }

  if (!shared) {
    // A unique name means no other candidate exists; a country difference is
    // normal for a multinational and is flagged, not treated as an error.
    return {
      klass: "plausible",
      reason: countryVerdict === "mismatch" ? "unique_name_country_differs" : "unique_name",
      evidence: { name: "unique", domain: "absent", country: countryVerdict },
    };
  }

  // Shared name, no domain evidence: country (and city) is what is left.
  if (contactCountry) {
    const countryMatches = family.filter((member) => member.country === contactCountry);
    const assignedMatches = companyCountry === contactCountry;
    if (countryMatches.length === 1 && assignedMatches) {
      return {
        klass: "plausible",
        reason: "country_identifies_the_assigned_company",
        evidence: { name: "shared", domain: "absent", country: "match" },
      };
    }
    if (!assignedMatches && countryMatches.length >= 1) {
      return {
        klass: "conflict",
        reason: "contact_country_identifies_a_different_company_of_the_same_name",
        evidence: { name: "shared", domain: "absent", country: countryVerdict },
        alternateCompanyIds: countryMatches.map((member) => member.id),
      };
    }
    if (countryMatches.length > 1) {
      return {
        klass: "unresolved",
        reason: "country_matches_several_companies_of_the_same_name",
        evidence: { name: "shared", domain: "absent", country: countryVerdict },
        gap: "needs a domain, city or source-level join key",
      };
    }
    return {
      klass: "unresolved",
      reason: "country_matches_no_company_of_the_same_name",
      evidence: { name: "shared", domain: "absent", country: countryVerdict },
      gap: "contact country is not evidence for any candidate",
    };
  }

  return {
    klass: "unresolved",
    reason: "shared_name_without_disambiguating_evidence",
    evidence: { name: "shared", domain: "absent", country: "absent" },
    gap: "no email domain and no country on the contact",
  };
}

/**
 * Run the audit over decoded index records.
 *
 * `companies` is `[{ ref, company }]` and `contactsByRef` maps a company ref to
 * its contacts — the same shapes `sample-report.mjs` reads out of the generated
 * objects, and the same shapes a later production index will have.
 */
export function auditAssociations({ companies, contactsByRef, sampleLimit = 25 }) {
  const { counts, families } = buildFamilies(companies);

  const totals = { companies: companies.length, contacts: 0, families: 0, companiesInFamilies: 0, largestFamily: 0 };
  const evidence = {
    company: { withDomain: 0, withLinkedin: 0, multiSource: 0, nameOnly: 0, flaggedAmbiguous: 0 },
    contact: { withEmailDomain: 0, withCountry: 0, withCity: 0, withNoEvidence: 0 },
    name: { unique: 0, shared: 0 },
    domain: { match: 0, mismatch: 0, absent: 0 },
    country: { match: 0, mismatch: 0, absent: 0 },
  };
  const byClass = { confirmed: 0, plausible: 0, unresolved: 0, conflict: 0 };
  const byReason = new Map();
  const problemCompanies = new Map();
  const familiesWithProblems = new Set();
  const sharedNameFamilies = new Set();
  /** What the index itself recorded, when it recorded anything (format v3). */
  const stored = {
    byCategory: { high_confidence: 0, plausible: 0, conflicting: 0 },
    unclassified: 0,
    moved: 0,
    /** Which kind of evidence each stored verdict rests on (see `REASON_BASIS`). */
    byBasis: { domain: 0, domain_contradiction: 0, record_identity: 0, country: 0, country_contradiction: 0, name: 0, unknown: 0 },
  };
  /** Legacy class → stored category, so the before/after comparison is measurable. */
  const crossTab = new Map();

  for (const [name, list] of families) {
    totals.families += 1;
    totals.companiesInFamilies += counts.get(name) ?? list.length;
    totals.largestFamily = Math.max(totals.largestFamily, counts.get(name) ?? list.length);
  }
  for (const { ref, company } of companies) {
    const name = company.normalizedName ?? "";
    const shared = (counts.get(name) ?? 0) > 1;
    if (shared) sharedNameFamilies.add(name);

    if (company.domain) evidence.company.withDomain += 1;
    if (company.linkedinUrl) evidence.company.withLinkedin += 1;
    if ((company.sources?.length ?? 0) > 1) evidence.company.multiSource += 1;
    if (!company.domain && !company.linkedinUrl) evidence.company.nameOnly += 1;
    if (company.ambiguous) evidence.company.flaggedAmbiguous += 1;

    const family = shared
      ? families.get(name) ?? [{ ref, id: company.id, domain: normalizeDomain(company.domain), country: company.country ?? null, city: company.city ?? null }]
      : [{ ref, id: company.id, domain: normalizeDomain(company.domain), country: company.country ?? null, city: company.city ?? null }];
    const contacts = contactsByRef.get(ref) ?? [];
    totals.contacts += contacts.length;

    for (const contact of contacts) {
      const contactDomain = emailDomain(contact.email);
      if (contactDomain) evidence.contact.withEmailDomain += 1;
      if (contact.country) evidence.contact.withCountry += 1;
      if (contact.city) evidence.contact.withCity += 1;
      if (!contactDomain && !contact.country && !contact.city) evidence.contact.withNoEvidence += 1;

      const result = classifyAssociation({ company, contact, family });
      byClass[result.klass] += 1;

      // Stored category, when the index has one. A v2 contact has none, and is
      // counted as `unclassified` — never folded into "plausible".
      const storedCategory = contact.association?.category ?? "unclassified";
      if (storedCategory === "unclassified") stored.unclassified += 1;
      else if (storedCategory in stored.byCategory) stored.byCategory[storedCategory] += 1;
      if (contact.association?.movedFrom) stored.moved += 1;
      // The evidence the INDEX says it used, mapped to one of six bases so
      // "associated through a company domain" and "through a record identifier"
      // are separate numbers rather than a single confidence label.
      if (storedCategory !== "unclassified") {
        stored.byBasis[REASON_BASIS[contact.association?.reason] ?? "unknown"] += 1;
      }
      const cell = `${result.klass}|${storedCategory}`;
      crossTab.set(cell, (crossTab.get(cell) ?? 0) + 1);
      byReason.set(result.reason, (byReason.get(result.reason) ?? 0) + 1);
      evidence.name[result.evidence.name] += 1;
      evidence.domain[result.evidence.domain] += 1;
      evidence.country[result.evidence.country] += 1;

      if (result.klass === "conflict" || result.klass === "unresolved") {
        if (shared) familiesWithProblems.add(name);
        const entry = problemCompanies.get(company.id) ?? {
          companyId: company.id,
          name: company.name,
          familySize: counts.get(name) ?? 1,
          contacts: 0,
          conflicts: 0,
          unresolved: 0,
          reasons: new Set(),
        };
        entry.contacts += 1;
        entry[result.klass === "conflict" ? "conflicts" : "unresolved"] += 1;
        entry.reasons.add(result.reason);
        problemCompanies.set(company.id, entry);
      }
    }
  }

  const problems = [...problemCompanies.values()]
    .map((entry) => ({ ...entry, reasons: [...entry.reasons].sort() }))
    .sort((a, b) => b.conflicts - a.conflicts || b.contacts - a.contacts || a.name.localeCompare(b.name));

  const sample = problems.slice(0, Math.max(0, sampleLimit));

  return {
    scope: totals,
    evidence,
    associations: {
      total: byClass.confirmed + byClass.plausible + byClass.unresolved + byClass.conflict,
      byClass,
      byReason: [...byReason.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      /**
       * Share of contacts whose association is supported by evidence outside the
       * name join. Deliberately *not* called accuracy: it measures how much of
       * the join the index can actually justify.
       */
      independentlySupportedShare:
        byClass.confirmed + byClass.plausible + byClass.unresolved + byClass.conflict === 0
          ? 0
          : byClass.confirmed / (byClass.confirmed + byClass.plausible + byClass.unresolved + byClass.conflict),
      /**
       * What the index stored (format v3). `unclassified` is every contact from a
       * format-v2 index, or a v3 contact written before Stage B ran — reported, not
       * hidden, so "no category" can never be read as a category.
       */
      stored,
      /**
       * Legacy class → stored category, contact by contact. The left column is the
       * read-only audit's own definition of the same evidence; the right column is
       * what Stage B decided. Disagreements are where the two rule sets differ, and
       * they are meant to be visible rather than reconciled by relabelling.
       */
      crossTab: [...crossTab.entries()]
        .map(([cell, count]) => {
          const [legacy, storedCategory] = cell.split("|");
          return { legacy, stored: storedCategory, contacts: count };
        })
        .sort((left, right) => left.legacy.localeCompare(right.legacy) || left.stored.localeCompare(right.stored)),
    },
    risk: {
      companiesWithProblems: problems.length,
      sharedNameFamiliesWithProblems: familiesWithProblems.size,
      sharedNameFamilies: sharedNameFamilies.size,
    },
    problemSample: sample,
    limitations: [
      "The index stores no source-level join key for contacts: the organization and contact files share no company identifier, so no association can be verified against the original rows — only against the evidence the index retains (email domain, country, city, normalized name).",
      "A normalized-name match is not evidence of identity. Every association the audit cannot support with a domain is reported as plausible or unresolved, never as confirmed.",
      "Rows rejected during pass 1 and contacts deduplicated during the merge are not in the index, so the audit cannot see the associations those rows would have produced.",
      "Contact country is weak evidence: a person may work for a company in another country. It is used here only to separate members of a same-name family, where it is the only evidence available.",
      "This is a read-only report. It does not reassign contacts, modify index objects or rebuild pass 1.",
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Preserved contacts and reconciliation (format v3)                          */
/* -------------------------------------------------------------------------- */

/** Count of one facet field, recomputed from the stored contacts. */
function facetCounts(contacts, pick) {
  const counts = new Map();
  for (const contact of contacts) {
    const value = pick(contact);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Is a stored facet list the exact top-N of the recomputed counts?
 *
 * `finalizeFacets` keeps the 40 largest buckets, so a company with more than 40
 * distinct cities is expected to store only some of them. The check therefore
 * verifies every stored bucket's count, and only demands completeness when the
 * recomputed field fits inside the stored list.
 */
function facetMatches(stored, actual, topN = 40) {
  const list = Array.isArray(stored) ? stored : [];
  const seen = new Set();
  let smallestStored = Infinity;
  for (const bucket of list) {
    if (!bucket || typeof bucket.value !== "string") return false;
    if (seen.has(bucket.value)) return false;
    seen.add(bucket.value);
    if ((actual.get(bucket.value) ?? 0) !== bucket.count) return false;
    smallestStored = Math.min(smallestStored, bucket.count);
  }
  if (actual.size <= topN) return actual.size === seen.size;
  // More distinct values than the stored list can hold: anything whose count beats
  // a stored bucket should have been kept instead.
  for (const [value, count] of actual) {
    if (seen.has(value)) continue;
    if (count > smallestStored) return false;
  }
  return list.length === topN;
}

/**
 * Summarize preserved contacts and reconcile company records against the
 * contacts actually stored.
 *
 * Section 11 asks for this in both directions: the manifest says what the run
 * thought it wrote, the objects say what is on disk. A disagreement is reported
 * as a finding ("unexpected contact loss" / "unexpected duplication"), never
 * smoothed over by recomputing the counter from the objects under audit.
 */
export function auditStoredAssociations({ companies, contactsByRef, unassigned = [], sampleLimit = 10 }) {
  const preserved = {
    total: 0,
    byCategory: { unresolved: 0, conflicting: 0 },
    byReason: new Map(),
    /** Preserved rows that lost the company name they claimed (should be zero). */
    missingClaimedName: 0,
  };
  const occurrences = new Map();
  const note = (id) => {
    if (typeof id === "string" && id) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  };

  for (const contact of unassigned) {
    preserved.total += 1;
    const category = contact.association?.category;
    if (category === "unresolved" || category === "conflicting") preserved.byCategory[category] += 1;
    const reason = contact.association?.reason ?? "unknown";
    preserved.byReason.set(reason, (preserved.byReason.get(reason) ?? 0) + 1);
    if (!contact.claimedCompanyName) preserved.missingClaimedName += 1;
    note(contact.id);
  }

  const count = { recorded: 0, actual: 0, mismatched: 0, sample: [] };
  const associations = { recorded: 0, actual: 0, mismatched: 0, sample: [] };
  const facets = {
    checked: 0,
    mismatched: 0,
    byField: { designation: 0, department: 0, seniority: 0, country: 0, city: 0, emailAvailable: 0, linkedinAvailable: 0 },
    sample: [],
  };
  let attached = 0;

  for (const { ref, company } of companies) {
    const contacts = contactsByRef.get(ref) ?? [];
    attached += contacts.length;
    for (const contact of contacts) note(contact.id);

    count.recorded += company.contactCount ?? 0;
    count.actual += contacts.length;
    if ((company.contactCount ?? 0) !== contacts.length) {
      count.mismatched += 1;
      if (count.sample.length < sampleLimit) {
        count.sample.push({ companyId: company.id, name: company.name, recorded: company.contactCount ?? 0, actual: contacts.length });
      }
    }

    if (company.associations) {
      const recorded =
        (company.associations.highConfidence ?? 0) + (company.associations.plausible ?? 0) + (company.associations.conflicting ?? 0);
      let high = 0;
      let plausible = 0;
      let conflicting = 0;
      for (const contact of contacts) {
        const category = contact.association?.category;
        if (category === "high_confidence") high += 1;
        else if (category === "plausible") plausible += 1;
        else if (category === "conflicting") conflicting += 1;
      }
      const actual = high + plausible + conflicting;
      associations.recorded += recorded;
      associations.actual += actual;
      const agrees =
        recorded === actual &&
        (company.associations.highConfidence ?? 0) === high &&
        (company.associations.plausible ?? 0) === plausible &&
        (company.associations.conflicting ?? 0) === conflicting;
      if (!agrees) {
        associations.mismatched += 1;
        if (associations.sample.length < sampleLimit) {
          associations.sample.push({
            companyId: company.id,
            name: company.name,
            recorded: {
              high: company.associations.highConfidence ?? 0,
              plausible: company.associations.plausible ?? 0,
              conflicting: company.associations.conflicting ?? 0,
            },
            actual: { high, plausible, conflicting },
          });
        }
      }
    }

    if (company.facets) {
      facets.checked += 1;
      const fields = [
        ["designation", company.facets.designations, facetCounts(contacts, (contact) => contact.designation || contact.title)],
        ["department", company.facets.departments, facetCounts(contacts, (contact) => contact.department)],
        ["seniority", company.facets.seniority, facetCounts(contacts, (contact) => contact.seniority)],
        ["country", company.facets.countries, facetCounts(contacts, (contact) => contact.country)],
        ["city", company.facets.cities, facetCounts(contacts, (contact) => contact.city)],
      ];
      const wrong = [];
      for (const [field, stored, actual] of fields) {
        if (!facetMatches(stored, actual)) {
          facets.byField[field] += 1;
          wrong.push(field);
        }
      }
      const email = contacts.filter((contact) => contact.email).length;
      const linkedin = contacts.filter((contact) => contact.linkedinUrl).length;
      if ((company.facets.emailAvailable ?? 0) !== email) {
        facets.byField.emailAvailable += 1;
        wrong.push("emailAvailable");
      }
      if ((company.facets.linkedinAvailable ?? 0) !== linkedin) {
        facets.byField.linkedinAvailable += 1;
        wrong.push("linkedinAvailable");
      }
      if (wrong.length) {
        facets.mismatched += 1;
        if (facets.sample.length < sampleLimit) facets.sample.push({ companyId: company.id, name: company.name, fields: wrong });
      }
    }
  }

  let duplicated = 0;
  const duplicateSample = [];
  for (const [id, times] of occurrences) {
    if (times < 2) continue;
    duplicated += times - 1;
    if (duplicateSample.length < sampleLimit) duplicateSample.push(id);
  }

  return {
    preserved: { ...preserved, byReason: [...preserved.byReason.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) },
    reconciliation: {
      companies: companies.length,
      attached,
      preserved: unassigned.length,
      contactCount: count,
      associations,
      facets,
      ids: { total: attached + unassigned.length, distinct: occurrences.size, duplicated, sample: duplicateSample },
    },
  };
}

/**
 * Recommendations, derived from the measured numbers — never generic advice.
 */
/** "1 contact" / "2 contacts" — so a one-off count never reads as a typo. */
function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export function auditRecommendations(report) {
  const out = [];
  const { byClass, total } = report.associations;
  const company = report.evidence.company;

  if (byClass.conflict > 0) {
    out.push(
      `Re-associate by domain before the full run: ${plural(byClass.conflict, "contact association")} point away from the company they are attached to (a different member of the same-name family owns the email domain or the country).`,
    );
  }
  if (byClass.unresolved > 0) {
    out.push(
      `Add a stable company key to the people source for ${plural(byClass.unresolved, "unresolved association")}: they sit on companies whose normalized name is shared and whose domain/country evidence cannot separate the candidates.`,
    );
  }
  if (company.withDomain / Math.max(1, report.scope.companies) < 0.5) {
    out.push(
      `Only ${company.withDomain.toLocaleString()} of ${report.scope.companies.toLocaleString()} companies carry a domain, so the strongest available evidence is missing on most records. Fixing domain coverage in the source improves both this join and search relevance.`,
    );
  }
  if (report.evidence.contact.withNoEvidence > 0) {
    out.push(
      `${plural(report.evidence.contact.withNoEvidence, "contact has", "contacts have")} no email, country or city at all, so they can only ever be attached by name.`,
    );
  }
  if (report.risk.sharedNameFamilies > 0) {
    out.push(
      `${plural(report.risk.sharedNameFamilies, "normalized name is", "normalized names are")} shared by more than one company (largest family ${report.scope.largestFamily}). Any rule change that merges same-name companies would corrupt contacts wholesale — keep them separate and resolve by evidence.`,
    );
  }
  if (total > 0 && byClass.confirmed === 0) {
    out.push(
      "No association is independently confirmed (not one contact's email domain matches its company's), so the audit's classes rest entirely on name uniqueness and country evidence. Treat the classes as a risk ranking, not a correctness proof.",
    );
  }

  const stored = report.associations?.stored;
  if (stored) {
    const classified = stored.byCategory.high_confidence + stored.byCategory.plausible + stored.byCategory.conflicting;
    if (classified === 0 && stored.unclassified > 0) {
      out.push(
        `None of the ${plural(stored.unclassified, "contact")} in this index carries a stored association category: it is a format-v2 index. Rebuild it under a NEW version (e.g. \`--version ${report.version}-assoc\`) to get Stage B categories — do not overwrite this one.`,
      );
    }
    if (classified > 0 && stored.moved === 0 && byClass.conflict > 0) {
      out.push(
        `No contact was reassigned even though the legacy audit flags ${plural(byClass.conflict, "contradicted association")}. Check that the rebuild ran with the current association rules before comparing the two.`,
      );
    }
  }

  if (report.preserved && report.preserved.missingClaimedName > 0) {
    out.push(
      `${plural(report.preserved.missingClaimedName, "preserved contact is", "preserved contacts are")} missing the company name they claimed, so they cannot be reviewed. This is a defect, not an evidence problem.`,
    );
  }

  const reconciliation = report.reconciliation;
  if (reconciliation) {
    if (reconciliation.contactCount.mismatched > 0) {
      out.push(
        `${plural(reconciliation.contactCount.mismatched, "company")} disagree with the contacts stored for it (contactCount sum ${num(reconciliation.contactCount.recorded)} vs ${num(reconciliation.contactCount.actual)} on disk). Fix the count before publishing: a wrong count is what a reviewer sees first.`,
      );
    }
    if (reconciliation.associations.mismatched > 0) {
      out.push(
        `${plural(reconciliation.associations.mismatched, "company")} disagree with their stored association split (high/plausible/conflicting), so the profile would misstate how many contacts are trusted.`,
      );
    }
    if (reconciliation.facets.mismatched > 0) {
      out.push(
        `${plural(reconciliation.facets.mismatched, "company")} have facet counts that do not match their stored contacts, so filtering by designation/country/linkedin would return the wrong rows.`,
      );
    }
    if (reconciliation.ids.duplicated > 0) {
      out.push(
        `${plural(reconciliation.ids.duplicated, "contact id")} occur more than once across companies and preserved objects. Deduplication must collapse them before publishing.`,
      );
    }
  }
  return out;
}

function pad(value, width) {
  const text = String(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function percent(part, whole) {
  if (!whole) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Human-readable report. Counts and company-level identifiers only. */
export function formatAuditReport(report) {
  const lines = [];
  const say = (line = "") => lines.push(line);
  const a = report.associations;
  const e = report.evidence;

  say("CompanyIntel association audit (read-only; existing index objects only)");
  say(`version ${report.version}   format ${report.indexFormatVersion ?? "unknown"}   directory ${report.dir}`);
  say(`measured at ${report.checkedAt} — company-level identifiers and counts only; no contact value is read or printed`);
  say("");
  say("Scope");
  say(`  companies                ${num(report.scope.companies)}`);
  say(`  contacts                 ${num(report.scope.contacts)}`);
  say(`  shared-name families     ${num(report.scope.families)}  (${num(report.scope.companiesInFamilies)} companies, largest ${num(report.scope.largestFamily)})`);
  say("");
  say("Evidence, reported separately");
  say(`  company has a domain     ${num(e.company.withDomain)}  (${percent(e.company.withDomain, report.scope.companies)})`);
  say(`  company has LinkedIn     ${num(e.company.withLinkedin)}`);
  say(`  company is name-only     ${num(e.company.nameOnly)}`);
  say(`  company flagged ambiguous ${num(e.company.flaggedAmbiguous)}`);
  say(`  company merged by strong identity (multi-source) ${num(e.company.multiSource)}`);
  say(`  contact has an email domain ${num(e.contact.withEmailDomain)}`);
  say(`  contact has a country    ${num(e.contact.withCountry)}`);
  say(`  contact has no evidence  ${num(e.contact.withNoEvidence)}`);
  say(`  name evidence      unique ${num(e.name.unique)}   shared ${num(e.name.shared)}`);
  say(`  domain evidence    match ${num(e.domain.match)}   mismatch ${num(e.domain.mismatch)}   absent ${num(e.domain.absent)}`);
  say(`  country evidence   match ${num(e.country.match)}   mismatch ${num(e.country.mismatch)}   absent ${num(e.country.absent)}`);
  say("");
  say("Association classes (a normalized-name match alone is never \"confirmed\")");
  say(`  confirmed   ${num(a.byClass.confirmed)}  (${percent(a.byClass.confirmed, a.total)})  independent of the name join`);
  say(`  plausible   ${num(a.byClass.plausible)}  (${percent(a.byClass.plausible, a.total)})  one candidate is consistent with the evidence`);
  say(`  unresolved  ${num(a.byClass.unresolved)}  (${percent(a.byClass.unresolved, a.total)})  the index cannot decide`);
  say(`  conflict    ${num(a.byClass.conflict)}  (${percent(a.byClass.conflict, a.total)})  evidence points at a different company`);
  say(`  independently supported by evidence outside the name join: ${(a.independentlySupportedShare * 100).toFixed(1)}%`);
  say("");
  say("By reason");
  for (const [reason, count] of a.byReason) say(`  ${pad(reason, 62)} ${num(count)}`);
  if (a.stored) {
    say("");
    say("Stored categories (what the index itself recorded; format v3 only)");
    say(`  high_confidence   ${num(a.stored.byCategory.high_confidence)}  independent evidence on the source record or in the email domain`);
    say(`  plausible         ${num(a.stored.byCategory.plausible)}  one company is favoured, not verified`);
    say(`  conflicting       ${num(a.stored.byCategory.conflicting)}  attached, disputed, never shown as verified`);
    say(`  unclassified      ${num(a.stored.unclassified)}  no category stored (format-v2 contact, or written before Stage B)`);
    say(`  moved between companies of the same name  ${num(a.stored.moved)}`);
    const basis = a.stored.byBasis ?? {};
    say("  evidence the stored verdicts rest on");
    say(`    company domain in the email            ${num(basis.domain)}`);
    say(`    source record's own employer identity  ${num(basis.record_identity)}  (domain/website/LinkedIn/scoped source id on the row)`);
    say(`    country evidence                       ${num(basis.country)}  (supporting)`);
    say(`    name uniqueness only                   ${num(basis.name)}`);
    say(`    domain contradiction                   ${num(basis.domain_contradiction)}`);
    say(`    country contradiction                  ${num(basis.country_contradiction)}`);
    if (basis.unknown) say(`    unrecognised reason                    ${num(basis.unknown)}`);
  }

  if (a.crossTab?.length) {
    say("");
    say("Before/after: legacy audit class → stored category (same evidence, two rule sets)");
    for (const row of a.crossTab) say(`  ${pad(row.legacy, 12)} → ${pad(row.stored, 16)} ${num(row.contacts)}`);
  }

  if (report.preserved) {
    say("");
    say("Preserved contacts (kept without an employer rather than attached by guess)");
    say(`  preserved total          ${num(report.preserved.total)}`);
    say(`  unresolved               ${num(report.preserved.byCategory.unresolved)}`);
    say(`  conflicting              ${num(report.preserved.byCategory.conflicting)}`);
    say(`  lost the name they claimed ${num(report.preserved.missingClaimedName)}  (must be 0)`);
    for (const [reason, count] of report.preserved.byReason) say(`  ${pad(reason, 62)} ${num(count)}`);
  }

  if (report.reconciliation) {
    const r = report.reconciliation;
    say("");
    say("Reconciliation (stored objects, not the run's own counters)");
    say(`  companies                ${num(r.companies)}`);
    say(`  contacts attached        ${num(r.attached)}`);
    say(`  contacts preserved       ${num(r.preserved)}`);
    say(`  contactCount sum         ${num(r.contactCount.recorded)} recorded, ${num(r.contactCount.actual)} on disk, ${num(r.contactCount.mismatched)} companies disagree`);
    say(`  association-count sum    ${num(r.associations.recorded)} recorded, ${num(r.associations.actual)} on disk, ${num(r.associations.mismatched)} companies disagree`);
    say(`  facets checked           ${num(r.facets.checked)} companies, ${num(r.facets.mismatched)} disagree`);
    say(
      `  facet fields wrong       designations ${num(r.facets.byField.designation)}, departments ${num(r.facets.byField.department)}, ` +
        `seniority ${num(r.facets.byField.seniority)}, countries ${num(r.facets.byField.country)}, cities ${num(r.facets.byField.city)}, ` +
        `email ${num(r.facets.byField.emailAvailable)}, linkedin ${num(r.facets.byField.linkedinAvailable)}`,
    );
    say(`  contact ids              ${num(r.ids.total)} stored, ${num(r.ids.distinct)} distinct, ${num(r.ids.duplicated)} unexpected duplicate(s)`);
    if (r.contactCount.sample.length) {
      say("  contactCount disagreements (company id + name only)");
      for (const row of r.contactCount.sample) {
        say(`    ${pad(row.companyId, 22)} ${pad(row.name, 34)} recorded ${String(row.recorded).padStart(4)}  on disk ${String(row.actual).padStart(4)}`);
      }
    }
    if (r.facets.sample.length) {
      say("  facet disagreements (company id + fields only)");
      for (const row of r.facets.sample) say(`    ${pad(row.companyId, 22)} ${pad(row.name, 34)} ${row.fields.join(", ")}`);
    }
  }

  say("");
  say(`Companies with at least one conflict or unresolved association: ${num(report.risk.companiesWithProblems)}`);
  say(`  of those, in a shared-name family: ${num(report.risk.sharedNameFamiliesWithProblems)} of ${num(report.risk.sharedNameFamilies)} families`);
  if (report.problemSample.length) {
    say("");
    say("Bounded sample of the most conflicting companies (company id + name only)");
    for (const row of report.problemSample) {
      say(
        `  ${pad(row.companyId, 22)} ${pad(row.name, 34)} family ${String(row.familySize).padStart(4)}  ` +
          `contacts ${String(row.contacts).padStart(4)}  conflicts ${String(row.conflicts).padStart(4)}  ` +
          `unresolved ${String(row.unresolved).padStart(4)}  ${row.reasons.join(", ")}`,
      );
    }
  }
  say("");
  say("Limitations");
  for (const limitation of report.limitations) say(`  - ${limitation}`);
  if (report.recommendations.length) {
    say("");
    say("Recommendations before the full production index");
    for (const recommendation of report.recommendations) say(`  - ${recommendation}`);
  }
  return lines.join("\n");
}
