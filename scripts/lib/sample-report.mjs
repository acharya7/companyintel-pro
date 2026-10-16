/**
 * Pure helpers for `scripts/sample-report.mjs`.
 *
 * Turns the objects a run actually wrote into association-quality numbers:
 * how many companies carry real identity (a domain / LinkedIn page / source id),
 * how many have contacts attached, and how many contacts sit on a company that
 * was matched from the organization file. Nothing here reads the source CSVs, and
 * no contact field is copied into the report — only counts.
 */

/** Fraction with one decimal, as a percentage string. */
export function percent(part, whole) {
  if (!whole) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Aggregate company and contact records into the association metrics.
 *
 * Inputs are plain decoded objects (`Company[]` and `Map<ref, Contact[]>`), so this
 * can be unit-tested with synthetic records.
 */
/**
 * `companies` is a list of `{ ref, company }` (the global document ref travels
 * with the record, because contacts are stored per company ref), and
 * `contactsByRef` maps a ref to the contacts stored for it.
 */
export function summariseAssociation({ companies, contactsByRef, duplicateContactRows = 0 }) {
  const total = companies.length;
  let withDomain = 0;
  let withLinkedin = 0;
  let withSourceId = 0;
  let nameOnly = 0;
  let withContacts = 0;
  let nameOnlyWithContacts = 0;
  let ambiguous = 0;
  let contactsTotal = 0;
  let contactsOnIdentifiedCompany = 0;
  let contactsOnNameOnlyCompany = 0;
  let contactsOnAmbiguousCompany = 0;
  let companiesWithEmail = 0;
  let companiesWithLinkedinContact = 0;

  companies.forEach(({ ref, company }) => {
    const identified = Boolean(company.domain || company.linkedinUrl);
    const attached = (company.contactCount ?? 0) > 0;
    const contacts = contactsByRef.get(ref) ?? [];
    if (company.domain) withDomain += 1;
    if (company.linkedinUrl) withLinkedin += 1;
    if ((company.sources?.length ?? 0) > 1) withSourceId += 1;
    if (!identified) nameOnly += 1;
    if (attached) withContacts += 1;
    if (!identified && attached) nameOnlyWithContacts += 1;
    if (company.ambiguous) ambiguous += 1;
    contactsTotal += contacts.length;
    if (identified) contactsOnIdentifiedCompany += contacts.length;
    else contactsOnNameOnlyCompany += contacts.length;
    if (company.ambiguous) contactsOnAmbiguousCompany += contacts.length;
    if (contacts.some((contact) => contact.email)) companiesWithEmail += 1;
    if (contacts.some((contact) => contact.linkedinUrl)) companiesWithLinkedinContact += 1;
  });

  return {
    companies: {
      total,
      withDomain,
      withLinkedin,
      multiSource: withSourceId,
      identified: total - nameOnly,
      nameOnly,
      withContacts,
      nameOnlyWithContacts,
      ambiguous,
      withEmailInContacts: companiesWithEmail,
      withLinkedinInContacts: companiesWithLinkedinContact,
    },
    contacts: {
      total: contactsTotal,
      onIdentifiedCompany: contactsOnIdentifiedCompany,
      onNameOnlyCompany: contactsOnNameOnlyCompany,
      onAmbiguousCompany: contactsOnAmbiguousCompany,
      duplicatedRows: duplicateContactRows,
    },
    /** Share of contacts attached to a company that has a domain or LinkedIn page. */
    associationRate: contactsTotal === 0 ? 0 : contactsOnIdentifiedCompany / contactsTotal,
  };
}

/**
 * Name-collision risk of the cross-file join.
 *
 * The two real files share no identifier, so a person row is attached to a company
 * by normalized name. This measures how often that join could have picked the
 * wrong company: contacts whose company name is shared by more than one record.
 * `disambiguableByCountry` counts the subset where exactly one record in the
 * family has the contact's country — evidence a future tiebreak could use.
 *
 * Pure: takes decoded records, so it is unit-tested with synthetic input.
 */
export function sharedNameRisk({ companies, contactsByRef }) {
  const byName = new Map();
  for (const { ref, company } of companies) {
    const list = byName.get(company.normalizedName) ?? [];
    list.push({ ref, company });
    byName.set(company.normalizedName, list);
  }

  let families = 0;
  let companiesInFamilies = 0;
  let largestFamily = 0;
  for (const list of byName.values()) {
    if (list.length > 1) {
      families += 1;
      companiesInFamilies += list.length;
      largestFamily = Math.max(largestFamily, list.length);
    }
  }

  let contactsOnSharedName = 0;
  let disambiguableByCountry = 0;
  let countryMatchesNone = 0;
  let noCountryEvidence = 0;

  for (const { ref, company } of companies) {
    const family = byName.get(company.normalizedName) ?? [];
    if (family.length <= 1) continue;
    for (const contact of contactsByRef.get(ref) ?? []) {
      contactsOnSharedName += 1;
      if (!contact.country) {
        noCountryEvidence += 1;
        continue;
      }
      const sameCountry = family.filter((entry) => entry.company.country === contact.country).length;
      if (sameCountry === 1) disambiguableByCountry += 1;
      else if (sameCountry === 0) countryMatchesNone += 1;
      else noCountryEvidence += 1;
    }
  }

  return { families, companiesInFamilies, largestFamily, contactsOnSharedName, disambiguableByCountry, countryMatchesNone, noCountryEvidence };
}

/**
 * Group the indexer's `rejected.jsonl` rows by reason and by source.
 *
 * A rejected row is never silently dropped: it is written with the reason it could
 * not be used, and this turns that file into the counts a report can state.
 */
export function rejectionSummary(rows) {
  const byReason = new Map();
  const bySource = new Map();
  for (const row of rows) {
    const reason = String(row?.reason ?? "unknown");
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const source = String(row?.source ?? "unknown");
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  const entries = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return { total: rows.length, byReason: entries(byReason), bySource: entries(bySource) };
}

function pad(value, width) {
  const text = String(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

export function formatSampleReport(report) {
  const { version, dir, counters, association, coverage, shards, sizes } = report;
  const lines = [];
  const say = (line = "") => lines.push(line);

  say(`CompanyIntel sample index report`);
  say(`version ${version}   directory ${dir}`);
  say(`measured at ${report.checkedAt} — counts only; no contact values are read or printed`);
  say("");
  say("Counters (recorded by the run)");
  say(`  rows read            ${num(counters.rowsRead)}`);
  for (const [id, perSource] of Object.entries(counters.perSource ?? {})) {
    say(`    ${pad(id, 6)}              ${num(perSource.rowsRead)} read, ${num(perSource.rowsRejected)} rejected, ${num(perSource.companies)} companies, ${num(perSource.contacts)} contacts`);
  }
  say(`  rows rejected        ${num(counters.rowsRejected)}`);
  say(`  unique companies     ${num(counters.uniqueCompanies)}`);
  say(`  unique contacts      ${num(counters.uniqueContacts)}`);
  say(`  duplicate rows       ${num(counters.duplicateRowsResolved)}`);
  say(`  ambiguous companies  ${num(counters.ambiguousCompanies)}   (same normalized name, contradictory identity — kept apart)`);
  say(`  rows without a company identifier  ${num(counters.recordsMissingCompanyId)}`);
  say("");
  say("Association quality (the objects on disk)");
  const c = association.companies;
  say(`  companies            ${num(c.total)}`);
  say(`  with a domain        ${num(c.withDomain)}  (${percent(c.withDomain, c.total)})`);
  say(`  with a LinkedIn page ${num(c.withLinkedin)}  (${percent(c.withLinkedin, c.total)})`);
  say(`  name-only            ${num(c.nameOnly)}  (${percent(c.nameOnly, c.total)})`);
  say(`  with >=1 contact     ${num(c.withContacts)}  (${percent(c.withContacts, c.total)})`);
  say(`  name-only with contacts  ${num(c.nameOnlyWithContacts)}`);
  say(`  flagged ambiguous    ${num(c.ambiguous)}`);
  say(
    `  contacts on an identified company  ${num(association.contacts.onIdentifiedCompany)}/${num(association.contacts.total)}` +
      `  (${percent(association.contacts.onIdentifiedCompany, association.contacts.total)})`,
  );
  say(`  contacts on a name-only company    ${num(association.contacts.onNameOnlyCompany)}`);
  say(`  contacts on an ambiguous company   ${num(association.contacts.onAmbiguousCompany)}`);
  say("");
  if (report.risk) {
    const r = report.risk;
    say("Cross-file join risk (the two files share no identifier, so people attach by company name)");
    say(`  shared-name families        ${num(r.families)}  (largest family ${num(r.largestFamily)}, ${num(r.companiesInFamilies)} companies)`);
    say(
      `  contacts on a shared name   ${num(r.contactsOnSharedName)}` +
        `  (${percent(r.contactsOnSharedName, association.contacts.total)} of all contacts)`,
    );
    say(`    disambiguable by country  ${num(r.disambiguableByCountry)}`);
    say(`    country matches none       ${num(r.countryMatchesNone)}`);
    say(`    no country evidence        ${num(r.noCountryEvidence)}`);
    say("");
  }
  if (report.rejections) {
    const rej = report.rejections;
    say(`Rejected rows (${num(rej.total)} — each written to rejected.jsonl with its reason, never dropped silently)`);
    for (const [reason, count] of rej.byReason) say(`  ${pad(reason, 26)} ${num(count)}`);
    say(`  by source: ${rej.bySource.map(([source, count]) => `${source} ${num(count)}`).join(", ")}`);
    say("");
  }
  if (counters.duplicateCompaniesResolved !== undefined) {
    say("Duplicate entities");
    say(`  duplicate rows resolved      ${num(counters.duplicateRowsResolved)}`);
    say(`  duplicate companies resolved ${num(counters.duplicateCompaniesResolved)}`);
    say(`  kept separate (ambiguous)    ${num(counters.ambiguousCompanies)}`);
    say("");
  }
  if (coverage) {
    const total = (coverage.email ?? 0) + (coverage.neither ?? 0) + Math.max(0, (association.contacts.total ?? 0) - (coverage.email ?? 0) - (coverage.neither ?? 0));
    say("Contact coverage (contacts with a usable value)");
    say(`  email     ${num(coverage.email)}  (${percent(coverage.email ?? 0, total)})`);
    say(`  linkedin  ${num(coverage.linkedin)}  (${percent(coverage.linkedin ?? 0, total)})`);
    say(`  phone     ${num(coverage.phone)}  (${percent(coverage.phone ?? 0, total)})`);
    say(`  none of the three  ${num(coverage.neither)}`);
    say("");
  }
  if (sizes) {
    say("Generated objects");
    say(`  objects   ${num(sizes.objects)}   companies ${sizes.companies ?? "unknown"}   contacts ${sizes.contacts ?? "unknown"}   indexes ${sizes.indexes ?? "unknown"}`);
    if (shards) say(`  shards    exact ${shards.exact} prefix ${shards.prefix} token ${shards.token} trigram ${shards.trigram} ids ${shards.ids}`);
    say("");
  }
  for (const note of report.notes ?? []) say(`note: ${note}`);
  return lines.join("\n");
}
