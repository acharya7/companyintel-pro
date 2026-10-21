/**
 * Canonical fields and real-header → canonical-field mapping.
 *
 * This lives in `src/shared` because three different runtimes need the same
 * answer to "which column is the company name?":
 *
 *   - the local indexer (`tools/indexer/src/mapping.ts`, re-exported from there)
 *   - the read-only R2 probe Worker (`probe/`), which reports mapping
 *     suggestions without ever indexing anything
 *   - the browser bundle, which carries the same document model
 *
 * Nothing here touches the filesystem, the network or the environment, so it
 * can run inside a Worker, in Bun/Node and in the browser unchanged. Entity
 * resolution (which company two rows describe) stays in the indexer: it needs
 * the disk-partitioned pipeline, not just column names.
 */

/** Canonical company fields the indexer understands. */
export const CANONICAL_COMPANY_FIELDS = [
  "companyname",
  "companydomain",
  "companywebsite",
  "companylinkedin",
  "companyid",
  "industry",
  "subindustry",
  "companycountry",
  "companystate",
  "companycity",
  "companysize",
  "companyrevenue",
] as const;

/** Canonical contact fields the indexer understands. */
export const CANONICAL_CONTACT_FIELDS = [
  "contactname",
  "firstname",
  "lastname",
  "jobtitle",
  "designation",
  "seniority",
  "department",
  "email",
  "phone",
  "linkedin",
  "contactcountry",
  "contactstate",
  "contactcity",
] as const;

export const ALL_CANONICAL_FIELDS: string[] = [...CANONICAL_COMPANY_FIELDS, ...CANONICAL_CONTACT_FIELDS];

/**
 * Header aliases, normalized. Extend these after running the profiler — that is
 * exactly what `unmappedHeaders` in the profile report is for.
 */
export const HEADER_ALIASES: Record<string, string[]> = {
  companyname: ["companyname", "company", "organization", "organisation", "employer", "accountname", "companylegalname", "businessname"],
  companydomain: ["companydomain", "domain", "website", "companywebsite", "webdomain", "domainname", "companyurl"],
  companywebsite: ["companywebsite", "websiteurl", "url", "companyurl"],
  companylinkedin: ["companylinkedin", "companylinkedinurl", "companylinkedinprofile", "organizationlinkedin"],
  companyid: ["companyid", "companyidentifier", "organizationid", "accountid", "companycode", "domainid"],
  industry: ["industry", "sector", "primaryindustry", "industryname"],
  subindustry: ["subindustry", "industrysector", "secondaryindustry", "niche"],
  companycountry: ["companycountry", "country", "countryname", "hqcountry", "headquarterscountry"],
  companystate: ["companystate", "state", "province", "region", "companystateprovince"],
  companycity: ["companycity", "city", "locality", "hqcity", "headquarterscity", "town"],
  companysize: ["companysize", "employees", "employeecount", "employeeRange", "companysizeemployees", "size", "headcount"],
  companyrevenue: ["companyrevenue", "revenue", "annualrevenue", "estimatedrevenue", "turnover"],
  contactname: ["contactname", "fullname", "name", "personname", "contactfullname"],
  firstname: ["firstname", "givenname", "first"],
  lastname: ["lastname", "surname", "familyname", "last"],
  jobtitle: ["jobtitle", "title", "position", "jobposition", "role"],
  designation: ["designation", "joblevel", "level", "jobfunctionlevel"],
  seniority: ["seniority", "senioritylevel", "managementlevel", "jobseniority"],
  department: ["department", "function", "jobfunction", "team"],
  email: ["email", "emailaddress", "workemail", "businessemail", "emailid", "contactemail"],
  phone: ["phone", "phonenumber", "telephone", "mobile", "contactnumber", "directphone", "contactphone"],
  /** A mobile column stays separate from a work/landline phone column. */
  mobile: ["mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "cellular", "personmobile"],
  linkedin: ["linkedin", "linkedinurl", "linkedinprofile", "personlinkedin", "contactlinkedin"],
  contactcountry: ["contactcountry", "personcountry", "contactlocationcountry"],
  contactstate: ["contactstate", "personstate", "contactlocationstate"],
  contactcity: ["contactcity", "personcity", "contactlocationcity"],
};

/** Normalize a header for matching: lowercase, alphanumeric only. */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Every alias, normalized, grouped by the canonical field it belongs to. */
export function aliasIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) index.set(normalizeHeader(alias), field);
  }
  return index;
}

/** Build a column-index map for one file from its real headers. */
export function buildColumnMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const normalized = headers.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const index = normalized.indexOf(normalizeHeader(alias));
      if (index !== -1) {
        map[field] = index;
        break;
      }
    }
  }
  return map;
}
