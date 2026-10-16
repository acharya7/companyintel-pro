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
      duplicatedRows: duplicateContactRows,
    },
    /** Share of contacts attached to a company that has a domain or LinkedIn page. */
    associationRate: contactsTotal === 0 ? 0 : contactsOnIdentifiedCompany / contactsTotal,
  };
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
  say("");
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
