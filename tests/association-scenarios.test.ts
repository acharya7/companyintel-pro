/**
 * The synthetic association scenarios, run through the real indexer.
 *
 * This is the quantitative report Section 6 asks for: one corpus that contains the
 * eleven situations the specification lists (identical names in different
 * countries, subsidiaries, similar brands, corporate domains, public providers,
 * conflicts, job changes, duplicates, missing identifiers, missing country/domain,
 * ambiguous names), built and indexed into a temporary directory, then measured.
 *
 * The numbers below are a regression lock, not an accuracy claim. The corpus is
 * adversarial and tiny; its category split says "the rules behave as documented on
 * constructed evidence", never "X% of real contacts are right".
 */

import { describe, expect, test } from "bun:test";

import { REQUIRED_COVERAGE, SCENARIOS, formatAssociationScenarioReport, runAssociationScenarios, scenarioCoverage } from "../scripts/lib/association-scenarios.mjs";

describe("synthetic association scenarios", () => {
  test("every required situation is covered by a scenario", () => {
    const coverage = scenarioCoverage();
    for (const requirement of REQUIRED_COVERAGE) {
      expect(coverage.get(requirement)?.length).toBeGreaterThan(0);
    }
    expect(coverage.size).toBe(REQUIRED_COVERAGE.length);
  });

  test("every scenario and every reconciliation invariant holds", async () => {
    const report = await runAssociationScenarios();
    const failures = [
      ...report.scenarios.filter((scenario) => !scenario.passed).map((scenario) => `${scenario.id}: ${scenario.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join(", ")}`),
      ...report.invariants.filter((invariant) => !invariant.ok).map((invariant) => `${invariant.id}: ${invariant.detail}`),
    ];
    expect(failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.synthetic).toBe(true);
  }, 60_000);

  test("the corpus accounts for every row exactly once", async () => {
    const report = await runAssociationScenarios();
    // 36 contact rows, 4 of which duplicate an earlier row for the same person
    // at the same employer.
    expect(report.totals).toEqual({
      rows: 36,
      stored: 32,
      high: 16,
      plausible: 9,
      conflicting: 3,
      unresolved: 4,
      preserved: 4,
      moved: 0,
      duplicates: 4,
    });
    // Nothing attached and nothing preserved can be double counted.
    expect(report.reconciliation.attached + report.reconciliation.preserved).toBe(32);
    expect(report.reconciliation.ids.duplicated).toBe(0);
    expect(report.reconciliation.contactCount.mismatched).toBe(0);
    expect(report.reconciliation.associations.mismatched).toBe(0);
    expect(report.reconciliation.facets.mismatched).toBe(0);
    // The run's own counters agree with the independent reconciliation.
    expect(report.counters.uniqueContacts).toBe(32);
    expect(report.counters.duplicateRowsResolved).toBe(4);
    expect(report.counters.contactsMoved ?? 0).toBe(0);
    // Association categories exist from format 3 onward; later formats keep them.
    expect(report.index.formatVersion).toBeGreaterThanOrEqual(3);
  }, 60_000);

  test("uncertain contacts are never presented as confirmed employees", async () => {
    const report = await runAssociationScenarios();
    const scenario = (id: string) => report.scenarios.find((entry) => entry.id === id)!;

    // Public mailboxes with no country can only be plausible, never high confidence.
    expect(scenario("public-email-providers")).toMatchObject({ high: 1, plausible: 3, conflicting: 0, unresolved: 0 });
    // A parent-company domain at a subsidiary is a possible match (country), never
    // verified employment at the subsidiary; ambiguous families stay unresolved.
    expect(scenario("subsidiaries-and-parent")).toMatchObject({ high: 2, plausible: 1, conflicting: 0 });
    expect(scenario("same-name-different-countries")).toMatchObject({ unresolved: 1, preserved: 1 });
    expect(scenario("ambiguous-names")).toMatchObject({ high: 2, conflicting: 1, unresolved: 1, preserved: 1 });
    // Conflicting evidence is attached and labelled, never verified, and never
    // counted as an employee by the profile.
    expect(scenario("conflicting-evidence")).toMatchObject({ high: 1, conflicting: 2, unresolved: 1 });
    // Duplicate rows collapse to one contact per person per employer.
    expect(scenario("duplicate-rows")).toMatchObject({ rows: 5, stored: 2, duplicates: 3 });
    expect(scenario("employees-changing-companies")).toMatchObject({ rows: 3, stored: 2, duplicates: 1, high: 2 });
  }, 60_000);

  test("no scenario records a reassignment the source row never claimed", async () => {
    const report = await runAssociationScenarios();
    for (const scenario of report.scenarios) expect(scenario.moved).toBe(0);
    expect(report.scenarios.every((scenario) => scenario.checks.every((check) => check.ok))).toBe(true);
  }, 60_000);

  test("the printed report is counts only — no contact values", async () => {
    const report = await runAssociationScenarios();
    const text = formatAssociationScenarioReport(report);
    expect(text).not.toContain("@");
    for (const scenario of SCENARIOS) {
      for (const contact of scenario.contacts) expect(text).not.toContain(contact.name);
    }
    expect(text).toContain("SYNTHETIC");
    expect(text).toContain("result: PASS");
  }, 60_000);
});
