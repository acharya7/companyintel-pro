/**
 * Association audit — the company ↔ contact join, classified by evidence.
 *
 * The two source files share no company identifier, so a person row is attached
 * to a company by *normalized name*. These tests pin down what the audit is
 * allowed to conclude from that:
 *
 *   - a normalized-name match alone is NEVER "confirmed" (the requirement the
 *     specification states explicitly);
 *   - evidence that is independent of the name join (the contact's email domain)
 *     is what confirms an association, and evidence that contradicts it is a
 *     conflict — never silently reassigned;
 *   - a same-name family with no disambiguating evidence is "unresolved", which is
 *     a real answer, not a failure;
 *   - the report contains company-level identifiers only: no contact name, email
 *     or phone ever reaches its output.
 *
 * The last case runs the actual script as a child process against a real
 * on-disk output layout, because the thing an operator runs is the CLI, not the
 * library.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASSOCIATION_CLASSES,
  auditAssociations,
  auditRecommendations,
  buildFamilies,
  classifyAssociation,
  emailDomain,
  formatAuditReport,
  sameDomain,
} from "../scripts/lib/association-audit.mjs";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "association-audit.mjs");

/** A contact email that must never appear in any report output. */
const SECRET_EMAIL = "priya.menon@vertexanalytics.example";

function company(overrides: Record<string, unknown>) {
  return {
    id: "c_x",
    name: "Acme",
    normalizedName: "acme",
    contactCount: 0,
    sources: [{ source: "csv1", row: 1 }],
    ...overrides,
  };
}

function contact(overrides: Record<string, unknown> = {}) {
  return { id: "p_x", fullName: "Person Example", ...overrides };
}

describe("domain evidence primitives", () => {
  test("emailDomain reads the host, not the whole address", () => {
    expect(emailDomain("Priya.Menon@VertexAnalytics.example")).toBe("vertexanalytics.example");
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });

  test("sameDomain accepts an exact host or a subdomain on a dot boundary", () => {
    expect(sameDomain("microsoft.com", "microsoft.com")).toBe(true);
    expect(sameDomain("in.ibm.com", "ibm.com")).toBe(true);
    expect(sameDomain("notmicrosoft.com", "microsoft.com")).toBe(false);
    expect(sameDomain(null, "microsoft.com")).toBe(false);
  });
});

describe("families", () => {
  test("groups only names that occur more than once", () => {
    const companies = [
      { ref: 0, company: company({ id: "c_1", normalizedName: "delta", domain: "delta.example" }) },
      { ref: 1, company: company({ id: "c_2", normalizedName: "delta" }) },
      { ref: 2, company: company({ id: "c_3", normalizedName: "globex" }) },
    ];
    const { counts, families } = buildFamilies(companies);
    expect(counts.get("delta")).toBe(2);
    expect(counts.get("globex")).toBe(1);
    expect([...families.keys()]).toEqual(["delta"]);
    expect(families.get("delta")!.length).toBe(2);
  });
});

describe("classification", () => {
  const deltaFamily = [
    { ref: 0, id: "c_us", domain: "deltasystems.example", country: "United States", city: "Austin" },
    { ref: 1, id: "c_de", domain: "delta-ltd.example", country: "Germany", city: "Hamburg" },
  ];

  test("a normalized-name match alone is never confirmed", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", normalizedName: "delta", domain: "deltasystems.example", country: "United States" }),
      contact: contact({ country: "United States" }),
      family: deltaFamily,
    });
    expect(result.klass).not.toBe("confirmed");
    expect(result.klass).toBe("plausible");
  });

  test("a matching email domain confirms the association", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", domain: "deltasystems.example" }),
      contact: contact({ email: "ada@deltasystems.example" }),
      family: deltaFamily,
    });
    expect(result.klass).toBe("confirmed");
    expect(result.reason).toBe("email_domain_matches_assigned_company");
  });

  test("an email domain that belongs to another member of the family is a conflict, with the alternate named", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", domain: "deltasystems.example" }),
      contact: contact({ email: "jan@delta-ltd.example" }),
      family: deltaFamily,
    });
    expect(result.klass).toBe("conflict");
    expect(result.reason).toBe("email_domain_belongs_to_another_company_of_the_same_name");
    expect(result.alternateCompanyIds).toEqual(["c_de"]);
  });

  test("an unrelated email domain is a conflict against the assigned company", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", domain: "deltasystems.example" }),
      contact: contact({ email: "someone@elsewhere.example" }),
      family: [deltaFamily[0]],
    });
    expect(result.klass).toBe("conflict");
    expect(result.reason).toBe("email_domain_contradicts_assigned_company");
  });

  test("a contact whose country identifies a different member is a conflict", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", domain: "deltasystems.example", country: "United States" }),
      contact: contact({ country: "Germany" }),
      family: deltaFamily,
    });
    expect(result.klass).toBe("conflict");
    expect(result.reason).toBe("contact_country_identifies_a_different_company_of_the_same_name");
    expect(result.alternateCompanyIds).toEqual(["c_de"]);
  });

  test("a country that matches no candidate is unresolved, never a silent match", () => {
    const result = classifyAssociation({
      company: company({ id: "c_us", country: "United States" }),
      contact: contact({ country: "India" }),
      family: deltaFamily,
    });
    expect(result.klass).toBe("unresolved");
    expect(result.reason).toBe("country_matches_no_company_of_the_same_name");
    expect(result.gap).toBeDefined();
  });

  test("a country shared by several candidates stays unresolved", () => {
    const both = [
      { ref: 0, id: "c_1", domain: null, country: "India", city: "Pune" },
      { ref: 1, id: "c_2", domain: null, country: "India", city: "Pune" },
    ];
    const result = classifyAssociation({
      company: company({ id: "c_1", country: "India" }),
      contact: contact({ country: "India" }),
      family: both,
    });
    expect(result.klass).toBe("unresolved");
    expect(result.reason).toBe("country_matches_several_companies_of_the_same_name");
  });

  test("a unique name needs nothing else to be plausible, and a country difference is flagged not rejected", () => {
    const unique = [{ ref: 0, id: "c_1", domain: null, country: "United States", city: "Austin" }];
    const same = classifyAssociation({
      company: company({ id: "c_1", country: "United States" }),
      contact: contact({ country: "United States" }),
      family: unique,
    });
    expect(same.klass).toBe("plausible");
    expect(same.reason).toBe("unique_name");

    const different = classifyAssociation({
      company: company({ id: "c_1", country: "United States" }),
      contact: contact({ country: "India" }),
      family: unique,
    });
    expect(different.klass).toBe("plausible");
    expect(different.reason).toBe("unique_name_country_differs");
  });
});

describe("aggregate audit", () => {
  const companies = [
    // Same-name family: one US record with a domain, one German record with a
    // different domain. Two contacts on the US record.
    { ref: 0, company: company({ id: "c_us", name: "Delta Systems", normalizedName: "delta", domain: "deltasystems.example", country: "United States" }) },
    { ref: 1, company: company({ id: "c_de", name: "Delta Ltd", normalizedName: "delta", domain: "delta-ltd.example", country: "Germany" }) },
    // Unique name, no identity evidence at all (name-only company).
    { ref: 2, company: company({ id: "c_globex", name: "Globex", normalizedName: "globex" }) },
  ];
  const contactsByRef = new Map<number, unknown[]>([
    // Confirmed by domain, and one unresolved on the shared name.
    [0, [contact({ email: SECRET_EMAIL.replace("vertexanalytics", "deltasystems"), country: "United States" }), contact({ fullName: "No Evidence" })]],
    [1, [contact({ email: "hans@delta-ltd.example" })]],
    [2, [contact({ country: "United States" })]],
  ]);

  test("counts every association exactly once and orders the classes by evidence", () => {
    const report = auditAssociations({ companies, contactsByRef });
    expect(report.scope.companies).toBe(3);
    expect(report.scope.contacts).toBe(4);
    expect(report.scope.families).toBe(1);
    expect(report.scope.companiesInFamilies).toBe(2);
    expect(report.associations.total).toBe(4);
    expect(report.associations.byClass.confirmed).toBe(2);
    expect(report.associations.byClass.plausible).toBe(1);
    expect(report.associations.byClass.unresolved).toBe(1);
    expect(report.associations.byClass.conflict).toBe(0);
    for (const klass of ASSOCIATION_CLASSES) expect(report.associations.byClass[klass]).toBeGreaterThanOrEqual(0);
  });

  test("reports domain, country and name evidence separately", () => {
    const report = auditAssociations({ companies, contactsByRef });
    expect(report.evidence.domain.match).toBe(2);
    expect(report.evidence.domain.absent).toBe(2);
    expect(report.evidence.name.shared).toBe(3);
    expect(report.evidence.name.unique).toBe(1);
    expect(report.evidence.company.withDomain).toBe(2);
    expect(report.evidence.company.nameOnly).toBe(1);
    // Only the second contact on the US record has no email, country or city at
    // all; the German contact and the Globex contact both carry evidence.
    expect(report.evidence.contact.withNoEvidence).toBe(1);
  });

  test("is deterministic", () => {
    const first = auditAssociations({ companies, contactsByRef });
    const second = auditAssociations({ companies, contactsByRef });
    expect(second).toEqual(first);
  });

  test("the bounded sample names companies, never contacts", () => {
    const conflicting = [
      { ref: 0, company: company({ id: "c_us", name: "Delta Systems", normalizedName: "delta", domain: "deltasystems.example", country: "United States" }) },
      { ref: 1, company: company({ id: "c_de", name: "Delta Ltd", normalizedName: "delta", domain: "delta-ltd.example", country: "Germany" }) },
    ];
    const report = auditAssociations({
      companies: conflicting,
      contactsByRef: new Map([[0, [contact({ email: "hans@delta-ltd.example", fullName: "Hans Example" })]]]),
      sampleLimit: 1,
    });
    expect(report.problemSample.length).toBe(1);
    expect(report.problemSample[0].companyId).toBe("c_us");
    expect(report.problemSample[0].name).toBe("Delta Systems");
    const serialised = JSON.stringify(report.problemSample);
    expect(serialised).not.toContain("hans@delta-ltd.example");
    expect(serialised).not.toContain("Hans Example");
  });

  test("a sample limit of zero is honoured (aggregates only)", () => {
    const report = auditAssociations({ companies, contactsByRef, sampleLimit: 0 });
    expect(report.problemSample).toEqual([]);
  });

  test("recommendations are derived from the measured numbers", () => {
    const report = auditAssociations({
      companies: [
        { ref: 0, company: company({ id: "c_1", normalizedName: "same" }) },
        { ref: 1, company: company({ id: "c_2", normalizedName: "same", country: "France" }) },
      ],
      // No evidence at all: the join is name-only, so the audit must call it
      // unresolved rather than guess which of the two companies owns the row.
      contactsByRef: new Map([[0, [contact()]]]),
    });
    expect(report.associations.byClass.unresolved).toBe(1);
    const recommendations = auditRecommendations(report);
    expect(recommendations.some((line: string) => line.includes("unresolved"))).toBe(true);
    expect(recommendations.some((line: string) => line.includes("shared by more than one company"))).toBe(true);
    // Nothing confirmed anywhere → the audit says so rather than implying accuracy.
    expect(recommendations.some((line: string) => line.includes("No association is independently confirmed"))).toBe(true);
  });

  test("states its own limitations instead of inventing certainty", () => {
    const report = auditAssociations({ companies, contactsByRef });
    const text = formatAuditReport({ ...report, version: "test-v1", dir: "/tmp", checkedAt: "now", recommendations: auditRecommendations(report) });
    expect(text).toContain("share no company identifier");
    expect(text).toContain("read-only report");
    expect(text).toContain("confirmed");
    expect(text).toContain("conflict");
    expect(text).not.toContain("@");
  });
});

describe("the audit script", () => {
  function writeVersion(dir: string, version: string, companies: unknown[], byCompany: Record<string, unknown[]>) {
    mkdirSync(join(dir, "companies", version), { recursive: true });
    mkdirSync(join(dir, "contacts", version), { recursive: true });
    mkdirSync(join(dir, "manifests", version), { recursive: true });
    writeFileSync(
      join(dir, "companies", version, "00000.json.gz"),
      gzipSync(Buffer.from(JSON.stringify({ firstRef: 0, companies }), "utf8")),
    );
    writeFileSync(
      join(dir, "contacts", version, "00000.json.gz"),
      gzipSync(Buffer.from(JSON.stringify({ firstRef: 0, byCompany }), "utf8")),
    );
    writeFileSync(
      join(dir, "manifests", version, "manifest.json"),
      JSON.stringify({ version, generatedAt: new Date(0).toISOString(), counters: { uniqueCompanies: companies.length, uniqueContacts: 2 } }),
    );
  }

  function audit(args: string[]) {
    const result = spawnSync("bun", [script, ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("audits the newest version and prints company-level identifiers only", () => {
    const dir = mkdtempSync(join(tmpdir(), "companyintel-audit-"));
    try {
      const version = "audit-v1";
      writeVersion(
        dir,
        version,
        [
          { id: "c_us", name: "Delta Systems", normalizedName: "delta", domain: "deltasystems.example", country: "United States", contactCount: 1, sources: [{ source: "csv1", row: 2 }] },
          { id: "c_de", name: "Delta Ltd", normalizedName: "delta", domain: "delta-ltd.example", country: "Germany", contactCount: 1, sources: [{ source: "csv1", row: 3 }] },
        ],
        {
          "0": [{ id: "p_1", fullName: "Hans Example", email: "hans@delta-ltd.example" }],
          "1": [{ id: "p_2", fullName: "Greta Example", email: "greta@delta-ltd.example" }],
        },
      );
      const run = audit(["--dir", dir, "--json"]);
      expect(run.status).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(report.version).toBe(version);
      expect(report.associations.total).toBe(2);
      // Contact 1 is on the wrong company of the family; contact 2 is correct.
      expect(report.associations.byClass.conflict).toBe(1);
      expect(report.associations.byClass.confirmed).toBe(1);
      expect(report.recommendations.length).toBeGreaterThan(0);
      // No contact value may appear anywhere in the report.
      expect(run.stdout).not.toContain("hans@delta-ltd.example");
      expect(run.stdout).not.toContain("Greta Example");

      const human = audit(["--dir", dir]);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain("Association classes");
      expect(human.stdout).toContain("Limitations");
      expect(human.stdout).not.toContain("hans@delta-ltd.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a missing directory and an empty one with a non-zero exit and a usable message", () => {
    const dir = mkdtempSync(join(tmpdir(), "companyintel-audit-empty-"));
    try {
      const missing = audit(["--dir", join(dir, "not-there")]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("No output directory");

      const empty = audit(["--dir", dir]);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("No manifest found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
