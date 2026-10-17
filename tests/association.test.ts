/**
 * The contact → company association rules, as units.
 *
 * Every case here is a rule from the specification: same-name companies with
 * different domains, corporate domains that belong to the same company, name-only
 * records, domain matches and contradictions, personal email providers,
 * multinational locations, subsidiaries, and the requirement that an ambiguous
 * family stays `unresolved` instead of "the first company wins".
 *
 * The module is pure, so these tests are the cheapest place to prove the evidence
 * hierarchy is what the documentation claims it is.
 */

import { describe, expect, test } from "bun:test";

import {
  ASSOCIATION_CATEGORIES,
  ASSOCIATION_CATEGORY_HINTS,
  MAX_CANDIDATE_IDS,
  NO_CLAIM_REF,
  ASSOCIATION_CATEGORY_LABELS,
  associateContact,
  associationMatchesFilter,
  auditClassForCategory,
  emailDomainOf,
  isBranchOf,
  isPublicEmailDomain,
  isTrustedAssociation,
  sameDomain,
  type AssociationCandidate,
  type AssociateInput,
} from "../src/shared/association";

/** A credible company record (domain + country), with everything else defaulted. */
function candidate(partial: Partial<AssociationCandidate> & { ref: number }): AssociationCandidate {
  return {
    id: `c_company${partial.ref}`,
    name: `Company ${partial.ref}`,
    normalizedName: "shared name",
    domain: null,
    linkedinUrl: null,
    country: null,
    state: null,
    city: null,
    hasStrongIdentity: Boolean(partial.domain ?? partial.linkedinUrl),
    ...partial,
  };
}

/** Two credible companies that share a normalized name but not a domain. */
function twoCompanies(): { a: AssociationCandidate; b: AssociationCandidate } {
  return {
    a: candidate({ ref: 0, id: "c_alpha", name: "Delta Systems Limited", domain: "deltasystems.example", country: "United States" }),
    b: candidate({ ref: 1, id: "c_beta", name: "Delta Systems Pvt Ltd", domain: "deltasystems.in", country: "India" }),
  };
}

function decide(input: Partial<AssociateInput> & { candidates: AssociationCandidate[]; claimedRef: number }): ReturnType<typeof associateContact> {
  return associateContact({
    contact: input.contact ?? {},
    claimedIdentity: input.claimedIdentity ?? false,
    ...input,
  });
}

/* -------------------------------------------------------------------------- */

describe("email-domain evidence primitives", () => {
  test("the domain is read from the address, never the local part", () => {
    expect(emailDomainOf("ada.lovelace@deltasystems.example")).toBe("deltasystems.example");
    expect(emailDomainOf("ada@mail.deltasystems.example")).toBe("mail.deltasystems.example");
    expect(emailDomainOf("no-at-sign")).toBeNull();
    expect(emailDomainOf("trailing@")).toBeNull();
    expect(emailDomainOf(undefined)).toBeNull();
  });

  test("a public mailbox provider is not corporate evidence", () => {
    for (const provider of ["gmail.com", "yahoo.co.uk", "outlook.com", "proton.me", "qq.com"]) {
      expect(isPublicEmailDomain(provider)).toBe(true);
    }
    expect(isPublicEmailDomain("acme.example")).toBe(false);
    expect(isPublicEmailDomain(null)).toBe(false);
  });

  test("a branch host belongs to the parent domain, but only in that direction", () => {
    expect(sameDomain("mail.acme.example", "acme.example")).toBe(true);
    expect(sameDomain("acme.example", "acme.example")).toBe(true);
    expect(sameDomain("acme.example", "unrelated.example")).toBe(false);
    expect(sameDomain(null, "acme.example")).toBe(false);
  });

  test("the four categories have one label source for the whole interface", () => {
    for (const category of ASSOCIATION_CATEGORIES) {
      expect(ASSOCIATION_CATEGORY_LABELS[category]).toBeTruthy();
      expect(ASSOCIATION_CATEGORY_HINTS[category]).toBeTruthy();
    }
    expect(isTrustedAssociation("high_confidence")).toBe(true);
    expect(isTrustedAssociation("plausible")).toBe(true);
    expect(isTrustedAssociation("conflicting")).toBe(false);
    // A format-v2 contact (no category) is never treated as disputed.
    expect(isTrustedAssociation(undefined)).toBe(true);
    expect(auditClassForCategory("high_confidence")).toBe("confirmed");
    expect(auditClassForCategory("conflicting")).toBe("conflict");
    expect(auditClassForCategory("unresolved")).toBe("unresolved");
  });

  test("the association filter is inert for contacts that predate categories", () => {
    expect(associationMatchesFilter(undefined, ["high_confidence"])).toBe(true);
    expect(associationMatchesFilter("plausible", ["high_confidence"])).toBe(false);
    expect(associationMatchesFilter("plausible", ["high_confidence", "plausible"])).toBe(true);
    expect(associationMatchesFilter("conflicting", undefined)).toBe(true);
  });
});

describe("same-name companies with different domains", () => {
  test("a corporate email domain selects exactly the company it belongs to", () => {
    const { a, b } = twoCompanies();
    const decision = decide({
      candidates: [a, b],
      claimedRef: a.ref,
      contact: { email: "divya.rao@deltasystems.in" },
    });
    expect(decision.category).toBe("high_confidence");
    expect(decision.assignedRef).toBe(b.ref);
    expect(decision.moved).toBe(true);
    expect(decision.reason).toBe("email_domain_matches_other_company_of_same_name");
    expect(decision.record.evidence.domain).toBe("match");
    expect(decision.record.evidence.name).toBe("shared");
  });

  test("an exact host match beats a branch relationship to the other company", () => {
    const { a, b } = twoCompanies();
    // `metrics.deltasystems.in` is a branch of B's domain and NOT of A's, but the
    // interesting case is B's own host: it must never be attributed to A just
    // because A's domain shares a suffix with nothing.
    const decision = decide({ candidates: [a, b], claimedRef: a.ref, contact: { email: "x@deltasystems.in" } });
    expect(decision.assignedRef).toBe(b.ref);
  });

  test("a matching domain confirms the assigned company without moving it", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: b.ref, contact: { email: "ravi.desai@deltasystems.in" } });
    expect(decision.category).toBe("high_confidence");
    expect(decision.assignedRef).toBe(b.ref);
    expect(decision.moved).toBe(false);
    expect(decision.reason).toBe("email_domain_matches_assigned_company");
  });
});

describe("subsidiaries, aliases and shared group domains", () => {
  test("two domains proven to belong to one company leave a single candidate", () => {
    // The resolver merges the two domains into ONE record (see mapping.ts), so the
    // family has one member and there is nothing that could be confused.
    const merged = candidate({ ref: 0, id: "c_merged", name: "Vertex Analytics", domain: "vertexanalytics.example", country: "India" });
    const decision = decide({ candidates: [merged], claimedRef: merged.ref, contact: { email: "someone@vertexanalytics.example" } });
    expect(decision.category).toBe("high_confidence");
    expect(decision.assignedRef).toBe(merged.ref);
    expect(decision.record.evidence.name).toBe("unique");
  });

  test("a branch mailbox under the company's own domain is the same company", () => {
    const parent = candidate({ ref: 0, id: "c_parent", name: "Acme Corporation", domain: "acme.example" });
    const decision = decide({ candidates: [parent], claimedRef: parent.ref, contact: { email: "ops@mail.acme.example" } });
    expect(decision.category).toBe("high_confidence");
    expect(decision.record.evidence.domain).toBe("sibling");
  });

  test("a parent-domain address is not a branch of a subsidiary's own domain", () => {
    // `isBranchOf` is directional: only a host UNDER the company's domain is a
    // branch of it. A person at the group domain is not thereby a verified
    // employee of the subsidiary, so this must never be high confidence.
    expect(isBranchOf("mail.acme.example", "acme.example")).toBe(true);
    expect(isBranchOf("acme.example", "mail.acme.example")).toBe(false);
    expect(isBranchOf("acme.example", "acme.example")).toBe(true);

    const subsidiary = candidate({ ref: 0, id: "c_sub", name: "Northwind Logistics", domain: "logistics.northwind.example", country: "United Kingdom" });
    const decision = decide({
      // A name-only claim: `claimedRef` is the placeholder record, not a candidate.
      candidates: [subsidiary],
      claimedRef: 99,
      contact: { email: "frank@northwind.example" },
    });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("single_strong_candidate");
    expect(decision.assignedRef).toBe(subsidiary.ref);
    expect(decision.record.evidence.domain).toBe("outside_family");
    // The branch direction still matches.
    const branch = decide({ candidates: [subsidiary], claimedRef: subsidiary.ref, contact: { email: "ops@mail.logistics.northwind.example" } });
    expect(branch.category).toBe("high_confidence");
  });

  test("a corporate alias domain that matches nobody is a contradiction, not a guess", () => {
    const company = candidate({ ref: 0, id: "c_acme", name: "Acme Corporation", domain: "acme.example" });
    const decision = decide({
      candidates: [company],
      claimedRef: company.ref,
      claimedIdentity: true,
      contact: { email: "contractor@acme-alias.example" },
    });
    expect(decision.category).toBe("conflicting");
    expect(decision.reason).toBe("email_domain_outside_name_family");
    // Never relocated on a mismatch: the claim is kept, flagged.
    expect(decision.assignedRef).toBe(company.ref);
    expect(decision.moved).toBe(false);
  });
});

describe("personal email providers", () => {
  test("a gmail address neither confirms nor contradicts an employer", () => {
    const { a, b } = twoCompanies();
    const decision = decide({
      candidates: [a, b],
      claimedRef: a.ref,
      claimedIdentity: true,
      contact: { email: "john.smith@gmail.com", country: "United States" },
    });
    // The record's own identity still supports A; the personal address is ignored.
    expect(decision.category).toBe("high_confidence");
    expect(decision.assignedRef).toBe(a.ref);
    expect(decision.record.evidence.domain).toBe("public_provider");
  });

  test("a personal address is not evidence for a name-only claim either", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: a.ref, contact: { email: "someone@yahoo.com" } });
    expect(decision.category).toBe("unresolved");
    expect(decision.record.evidence.domain).toBe("public_provider");
  });
});

describe("multinational employees and country evidence", () => {
  test("a country difference alone never conflicts with a uniquely named company", () => {
    const company = candidate({ ref: 0, id: "c_acme", name: "Acme Corporation", domain: "acme.example", country: "United States" });
    const decision = decide({
      candidates: [company],
      claimedRef: company.ref,
      contact: { email: "ana.silva@acme.example", country: "Brazil" },
    });
    expect(decision.category).toBe("high_confidence"); // the domain matches; country is irrelevant
    const noDomain = decide({ candidates: [company], claimedRef: company.ref, contact: { country: "Brazil" } });
    expect(noDomain.category).toBe("plausible");
    expect(noDomain.reason).toBe("unique_name");
  });

  test("country evidence flags a shared-name claim that points at another member", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: a.ref, contact: { country: "India" } });
    expect(decision.category).toBe("conflicting");
    expect(decision.reason).toBe("country_points_to_other_company_of_same_name");
    expect(decision.assignedRef).toBe(a.ref);
    expect(decision.candidateCompanyIds).toEqual([b.id]);
  });

  test("country evidence supports the assigned company as plausible", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: a.ref, contact: { country: "United States" } });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("country_supports_assigned_company");
    expect(decision.assignedRef).toBe(a.ref);
  });

  test("country identifies the employer when the claim is only a name", () => {
    const { a, b } = twoCompanies();
    // Candidate list excludes the name-only claim (see build.ts), so the claim is
    // not among the candidates at all.
    const decision = decide({ candidates: [a, b], claimedRef: 99, contact: { country: "India" } });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("country_identifies_company");
    expect(decision.assignedRef).toBe(b.ref);
  });
});

describe("contacts with no reliable employer evidence", () => {
  test("a genuinely ambiguous family stays unresolved and attaches to nothing", () => {
    const { a, b } = twoCompanies();
    // No identity on the record, no domain, no country: nothing separates the two
    // companies, so the contact is preserved rather than guessed onto one of them.
    const decision = decide({ candidates: [a, b], claimedRef: a.ref });
    expect(decision.category).toBe("unresolved");
    expect(decision.reason).toBe("several_candidates_remain");
    expect(decision.assignedRef).toBeNull();
    expect(decision.candidateCompanyIds?.sort()).toEqual([a.id, b.id].sort());
    // Two candidates fit inside the cap, so the stored record is complete.
    expect(decision.record.candidateCompanyIds).toHaveLength(2);
    expect(decision.record.candidateCount).toBe(2);
  });

  test("several companies with the same name and country stay unresolved", () => {
    const a = candidate({ ref: 0, id: "c_a", domain: "a.example", country: "United States" });
    const b = candidate({ ref: 1, id: "c_b", domain: "b.example", country: "United States" });
    const decision = decide({ candidates: [a, b], claimedRef: a.ref, contact: { country: "United States" } });
    expect(decision.category).toBe("unresolved");
    expect(decision.record.evidence.country).toBe("ambiguous");
  });

  test("one credible candidate among name-only records is plausible, not verified", () => {
    const credible = candidate({ ref: 0, id: "c_only", domain: "only.example" });
    const placeholder = candidate({ ref: 1, id: "c_placeholder", hasStrongIdentity: false });
    const decision = decide({ candidates: [credible, placeholder], claimedRef: placeholder.ref });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("single_strong_candidate");
    expect(decision.assignedRef).toBe(credible.ref);
  });

  test("a family of nothing but name-only records is plausible, never verified", () => {
    const placeholder = candidate({ ref: 0, id: "c_placeholder", hasStrongIdentity: false });
    const decision = decide({ candidates: [placeholder], claimedRef: placeholder.ref });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("unique_name");
  });

  test("a single name-only member is plausible rather than unresolved", () => {
    const placeholder = candidate({ ref: 0, id: "c_placeholder", hasStrongIdentity: false });
    const other = candidate({ ref: 1, id: "c_other", hasStrongIdentity: false });
    const decision = decide({ candidates: [placeholder, other], claimedRef: placeholder.ref });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("no_credible_candidate");
    expect(decision.assignedRef).toBe(placeholder.ref);
  });
});

describe("a contact row that carried no employer identity has no employer claim", () => {
  test("the no-claim sentinel is never one of the candidates", () => {
    const { a, b } = twoCompanies();
    // A row that names only "Delta Systems" must not be attached to whichever
    // record happened to own the shared name key. Its own domain names the employer.
    const decision = decide({ candidates: [a, b], claimedRef: NO_CLAIM_REF, contact: { email: "x@deltasystems.in" } });
    expect(decision.category).toBe("high_confidence");
    expect(decision.assignedRef).toBe(b.ref);
    expect(decision.reason).toBe("email_domain_matches_assigned_company");
    // Nothing was claimed, so nothing was "moved away from".
    expect(decision.moved).toBe(false);
  });

  test("country evidence identifies the matching member instead of accusing the first", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: NO_CLAIM_REF, contact: { country: "India" } });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("country_identifies_company");
    expect(decision.assignedRef).toBe(b.ref);
  });

  test("a corporate domain outside the family never turns into a conflict with an arbitrary member", () => {
    const { a, b } = twoCompanies();
    const decision = decide({ candidates: [a, b], claimedRef: NO_CLAIM_REF, contact: { email: "someone@contractor.example" } });
    expect(decision.category).toBe("unresolved");
    expect(decision.assignedRef).toBeNull();
    expect(decision.candidateCompanyIds?.sort()).toEqual([a.id, b.id].sort());
  });

  test("a family of name-only records still answers with a real member, never the sentinel", () => {
    const placeholder = candidate({ ref: 0, id: "c_placeholder", hasStrongIdentity: false });
    const decision = decide({ candidates: [placeholder], claimedRef: NO_CLAIM_REF });
    expect(decision.category).toBe("plausible");
    expect(decision.reason).toBe("no_credible_candidate");
    expect(decision.assignedRef).toBe(placeholder.ref);
  });
});

describe("record-provided identity versus other evidence", () => {
  test("a row that names its own employer is high confidence", () => {
    const { a } = twoCompanies();
    const decision = decide({ candidates: [a], claimedRef: a.ref, claimedIdentity: true });
    expect(decision.category).toBe("high_confidence");
    expect(decision.reason).toBe("row_carries_employer_identity");
    expect(decision.record.evidence.rowIdentity).toBe(true);
  });

  test("a person's email domain that contradicts the row's own identity is a conflict", () => {
    const { a, b } = twoCompanies();
    const decision = decide({
      candidates: [a, b],
      claimedRef: a.ref,
      claimedIdentity: true,
      contact: { email: "kyle.adams@deltasystems.in" },
    });
    expect(decision.category).toBe("conflicting");
    expect(decision.reason).toBe("email_domain_conflicts_with_row_identity");
    // Two signals, two answers: nothing is relocated on a contradiction.
    expect(decision.assignedRef).toBe(a.ref);
    expect(decision.moved).toBe(false);
    expect(decision.candidateCompanyIds).toEqual([b.id]);
  });
});

describe("determinism and shape", () => {
  test("the same input always yields the same verdict, whatever the candidate order", () => {
    const { a, b } = twoCompanies();
    const input = { candidates: [a, b], claimedRef: a.ref, contact: { email: "x@deltasystems.in" } };
    const first = decide(input);
    const again = decide(input);
    const reversed = decide({ ...input, candidates: [b, a] });
    expect(again).toEqual(first);
    expect(reversed.assignedRef).toBe(first.assignedRef);
    expect(reversed.category).toBe(first.category);
    expect(reversed.record.reason).toBe(first.record.reason);
  });

  test("only unresolved detaches a contact; every other category names a company", () => {
    const { a, b } = twoCompanies();
    const cases: Parameters<typeof decide>[0][] = [
      { candidates: [a], claimedRef: a.ref, claimedIdentity: true },
      { candidates: [a, b], claimedRef: a.ref, contact: { email: "x@deltasystems.in" } },
      { candidates: [a, b], claimedRef: a.ref, contact: { country: "United States" } },
      { candidates: [a, b], claimedRef: a.ref },
    ];
    for (const input of cases) {
      const decision = decide(input);
      if (decision.category === "unresolved") expect(decision.assignedRef).toBeNull();
      else expect(decision.assignedRef).not.toBeNull();
      expect(decision.record.category).toBe(decision.category);
      expect(decision.record.reason).toBe(decision.reason);
      expect(decision.record.evidence.candidates).toBe(input.candidates.length);
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Scale: one name family with a thousand members, judged for two thousand
 * contacts. The decision is per contact and scans the family's domains, so this
 * pins down that a very large shared name stays answerable instead of turning
 * into the quadratic case (`1,000 companies × 100,000 contacts`).
 */
describe("a very large shared-name family", () => {
  const FAMILY = 1000;
  test("answers 2,000 contacts against 1,000 same-name companies in bounded time", () => {
    const family: AssociationCandidate[] = Array.from({ length: FAMILY }, (_, index) =>
      candidate({
        ref: index,
        id: `c_${index}`,
        name: `Acme ${index}`,
        normalizedName: "acme",
        domain: `acme-${index}.example`,
        country: "United States",
      }),
    );

    const contacts = 2000;
    let unresolved = 0;
    const started = performance.now();
    for (let index = 0; index < contacts; index += 1) {
      const withDomain = index % 2 === 1;
      const decision = decide({
        candidates: family,
        claimedRef: 0,
        contact: withDomain ? { email: `person${index}@acme-${(index * 7) % FAMILY}.example` } : { country: "United States" },
      });
      // No domain and a country every member shares: nothing separates the
      // candidates, so the honest answer is `unresolved` — never "the first one".
      if (withDomain) expect(decision.category).toBe("high_confidence");
      else {
        expect(decision.category).toBe("unresolved");
        // The decision carries every candidate; the STORED record keeps a bounded
        // sample plus the real count, so a thousand-member family cannot bloat it.
        expect(decision.candidateCompanyIds).toHaveLength(FAMILY);
        expect(decision.record.candidateCompanyIds).toHaveLength(MAX_CANDIDATE_IDS);
        expect(decision.record.candidateCount).toBe(FAMILY);
        unresolved += 1;
      }
    }
    const elapsedMs = performance.now() - started;
    expect(unresolved).toBe(contacts / 2);
    // Generous on purpose (a debug CI run is several times slower than a release
    // run); the point is that the cost is per contact, not per candidate pair.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
