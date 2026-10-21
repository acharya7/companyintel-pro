/**
 * PREVIEW-ONLY SAMPLE DATASET
 * ===========================
 *
 * The real application searches the company/contact index built from the two
 * CSV files in Cloudflare R2. This module exists so the interface can be
 * developed, demonstrated and tested without those files, and it is *always*
 * labelled "SAMPLE DATA" in the UI (`DatasetStatusResponse.dataOrigin`).
 *
 * Everything here is generated deterministically from a fixed seed, so the same
 * numbers appear on every reload. No statistic shown for this dataset is ever
 * presented as production data: the dashboard reads the sample dataset's real
 * counts and marks them as sample-only.
 */

import type { AssociationCounts, Company, Contact, ContactFilters, FacetBucket, UnassignedContact } from "@/shared/models";
import {
  MAX_CANDIDATE_IDS,
  associateContact,
  type AssociationCandidate,
  type AssociationRecord,
} from "@/shared/association";
import { contactMatchesFilters as sharedContactMatchesFilters } from "@/shared/contact-filter";
import { companyId, contactId } from "@/shared/hash";
import { normalizeName, nameVariants } from "@/shared/normalize";

export const SAMPLE_DATASET_VERSION = "sample-v1";
export const SAMPLE_DATASET_LABEL = "Sample dataset (synthetic, preview only)";

/** Deterministic PRNG (mulberry32) so the sample data never changes. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Seed {
  name: string;
  domain: string;
  industry: string;
  country: string;
  city: string;
  size: string;
  revenue: string;
}

/** Recognisable public companies so typo-tolerance is easy to demonstrate. */
const SEEDS: Seed[] = [
  { name: "Microsoft Corporation", domain: "microsoft.com", industry: "Software", country: "United States", city: "Redmond", size: "10000+", revenue: "> $100B" },
  { name: "Google LLC", domain: "google.com", industry: "Internet", country: "United States", city: "Mountain View", size: "10000+", revenue: "> $100B" },
  { name: "Alphabet Inc.", domain: "abc.xyz", industry: "Internet", country: "United States", city: "Mountain View", size: "10000+", revenue: "> $100B" },
  { name: "Apple Inc.", domain: "apple.com", industry: "Consumer Electronics", country: "United States", city: "Cupertino", size: "10000+", revenue: "> $100B" },
  { name: "Amazon.com, Inc.", domain: "amazon.com", industry: "E-commerce", country: "United States", city: "Seattle", size: "10000+", revenue: "> $100B" },
  { name: "Meta Platforms, Inc.", domain: "meta.com", industry: "Internet", country: "United States", city: "Menlo Park", size: "10000+", revenue: "> $100B" },
  { name: "International Business Machines Corporation", domain: "ibm.com", industry: "IT Services", country: "United States", city: "Armonk", size: "10000+", revenue: "> $50B" },
  { name: "IBM India Private Limited", domain: "in.ibm.com", industry: "IT Services", country: "India", city: "Bengaluru", size: "10000+", revenue: "$5B - $10B" },
  { name: "Infosys Limited", domain: "infosys.com", industry: "IT Services", country: "India", city: "Bengaluru", size: "10000+", revenue: "$10B - $50B" },
  { name: "Tata Consultancy Services Limited", domain: "tcs.com", industry: "IT Services", country: "India", city: "Mumbai", size: "10000+", revenue: "$10B - $50B" },
  { name: "Tata Steel Limited", domain: "tatasteel.com", industry: "Steel", country: "India", city: "Mumbai", size: "10000+", revenue: "$10B - $50B" },
  { name: "Tata Motors Limited", domain: "tatamotors.com", industry: "Automotive", country: "India", city: "Mumbai", size: "10000+", revenue: "$10B - $50B" },
  { name: "Reliance Industries Limited", domain: "ril.com", industry: "Conglomerate", country: "India", city: "Mumbai", size: "10000+", revenue: "> $100B" },
  { name: "Reliance Jio Infocomm Limited", domain: "jio.com", industry: "Telecom", country: "India", city: "Mumbai", size: "10000+", revenue: "$10B - $50B" },
  { name: "Hindustan Unilever Limited", domain: "hul.co.in", industry: "Consumer Goods", country: "India", city: "Mumbai", size: "10000+", revenue: "$5B - $10B" },
  { name: "Wipro Limited", domain: "wipro.com", industry: "IT Services", country: "India", city: "Bengaluru", size: "10000+", revenue: "$5B - $10B" },
  { name: "HCL Technologies Limited", domain: "hcltech.com", industry: "IT Services", country: "India", city: "Noida", size: "10000+", revenue: "$10B - $50B" },
  { name: "Nestlé S.A.", domain: "nestle.com", industry: "Food & Beverage", country: "Switzerland", city: "Vevey", size: "10000+", revenue: "> $50B" },
  { name: "Siemens AG", domain: "siemens.com", industry: "Industrial", country: "Germany", city: "Munich", size: "10000+", revenue: "> $50B" },
  { name: "SAP SE", domain: "sap.com", industry: "Software", country: "Germany", city: "Walldorf", size: "10000+", revenue: "$10B - $50B" },
  { name: "Volkswagen AG", domain: "volkswagen.com", industry: "Automotive", country: "Germany", city: "Wolfsburg", size: "10000+", revenue: "> $100B" },
  { name: "TotalEnergies SE", domain: "totalenergies.com", industry: "Energy", country: "France", city: "Courbevoie", size: "10000+", revenue: "> $100B" },
  { name: "LVMH Moët Hennessy Louis Vuitton SE", domain: "lvmh.com", industry: "Luxury Goods", country: "France", city: "Paris", size: "10000+", revenue: "$10B - $50B" },
  { name: "Samsung Electronics Co., Ltd.", domain: "samsung.com", industry: "Consumer Electronics", country: "South Korea", city: "Suwon", size: "10000+", revenue: "> $100B" },
  { name: "Toyota Motor Corporation", domain: "toyota.com", industry: "Automotive", country: "Japan", city: "Toyota City", size: "10000+", revenue: "> $100B" },
  { name: "Sony Group Corporation", domain: "sony.com", industry: "Consumer Electronics", country: "Japan", city: "Tokyo", size: "10000+", revenue: "> $50B" },
  { name: "Unilever PLC", domain: "unilever.com", industry: "Consumer Goods", country: "United Kingdom", city: "London", size: "10000+", revenue: "> $50B" },
  { name: "AstraZeneca PLC", domain: "astrazeneca.com", industry: "Pharmaceuticals", country: "United Kingdom", city: "Cambridge", size: "10000+", revenue: "> $50B" },
  { name: "HSBC Holdings plc", domain: "hsbc.com", industry: "Banking", country: "United Kingdom", city: "London", size: "10000+", revenue: "> $50B" },
  { name: "Barclays PLC", domain: "barclays.com", industry: "Banking", country: "United Kingdom", city: "London", size: "10000+", revenue: "> $50B" },
  { name: "JPMorgan Chase & Co.", domain: "jpmorganchase.com", industry: "Banking", country: "United States", city: "New York", size: "10000+", revenue: "> $100B" },
  { name: "Goldman Sachs Group, Inc.", domain: "goldmansachs.com", industry: "Banking", country: "United States", city: "New York", size: "10000+", revenue: "> $50B" },
  { name: "NVIDIA Corporation", domain: "nvidia.com", industry: "Semiconductors", country: "United States", city: "Santa Clara", size: "10000+", revenue: "> $50B" },
  { name: "Intel Corporation", domain: "intel.com", industry: "Semiconductors", country: "United States", city: "Santa Clara", size: "10000+", revenue: "$10B - $50B" },
  { name: "Advanced Micro Devices, Inc.", domain: "amd.com", industry: "Semiconductors", country: "United States", city: "Santa Clara", size: "10000+", revenue: "$10B - $50B" },
  { name: "Salesforce, Inc.", domain: "salesforce.com", industry: "Software", country: "United States", city: "San Francisco", size: "10000+", revenue: "> $10B" },
  { name: "Oracle Corporation", domain: "oracle.com", industry: "Software", country: "United States", city: "Austin", size: "10000+", revenue: "> $50B" },
  { name: "Adobe Inc.", domain: "adobe.com", industry: "Software", country: "United States", city: "San Jose", size: "10000+", revenue: "$10B - $50B" },
  { name: "Cognizant Technology Solutions Corporation", domain: "cognizant.com", industry: "IT Services", country: "United States", city: "Teaneck", size: "10000+", revenue: "$10B - $50B" },
  { name: "Capgemini SE", domain: "capgemini.com", industry: "IT Services", country: "France", city: "Paris", size: "10000+", revenue: "$10B - $50B" },
];

const STEMS = [
  "Northwind", "Blue Harbor", "Ironclad", "Silverline", "Vertex", "Lumen", "Orbit", "Granite",
  "Cobalt", "Meridian", "Pinnacle", "Summit", "Quantum", "Helix", "Aurora", "Cedar",
  "Falcon", "Harborview", "Brightpath", "Keystone", "Amber", "Nimbus", "Vantage", "Solstice",
  "Evergreen", "Atlas", "Delta", "Zephyr", "Onyx", "Cardinal", "Beacon", "Talon",
];

const INDUSTRY_WORDS = [
  "Logistics", "Pharmaceuticals", "Analytics", "Manufacturing", "Foods", "Retail",
  "Energy", "Financial Services", "Healthcare", "Robotics", "Engineering", "Telecom",
  "Chemicals", "Media", "Education", "Real Estate", "Insurance", "Packaging", "Textiles", "Automation",
];

const SUFFIXES = ["Limited", "Inc.", "LLC", "GmbH", "Pvt Ltd", "PLC", "S.A.", "Co., Ltd.", "LLP", "Corporation"];

const COUNTRIES: { country: string; cities: string[] }[] = [
  { country: "United States", cities: ["New York", "Austin", "Chicago", "Seattle", "Denver", "Boston", "Atlanta"] },
  { country: "India", cities: ["Mumbai", "Bengaluru", "Hyderabad", "Pune", "Chennai", "Delhi", "Noida"] },
  { country: "United Kingdom", cities: ["London", "Manchester", "Birmingham", "Leeds", "Bristol"] },
  { country: "Germany", cities: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Stuttgart"] },
  { country: "Singapore", cities: ["Singapore"] },
  { country: "Canada", cities: ["Toronto", "Vancouver", "Montreal", "Calgary"] },
  { country: "Australia", cities: ["Sydney", "Melbourne", "Brisbane", "Perth"] },
  { country: "Netherlands", cities: ["Amsterdam", "Rotterdam", "Utrecht"] },
  { country: "United Arab Emirates", cities: ["Dubai", "Abu Dhabi", "Sharjah"] },
  { country: "Brazil", cities: ["São Paulo", "Rio de Janeiro", "Curitiba"] },
];

const SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "10001+"];
const REVENUES = ["< $1M", "$1M - $10M", "$10M - $50M", "$50M - $250M", "$250M - $1B", "> $1B"];

const FIRST_NAMES = [
  "Aarav", "Aditi", "Alex", "Amelia", "Ananya", "Arjun", "Benjamin", "Carla", "Charlotte", "Daniel",
  "Dhruv", "Elena", "Emma", "Fatima", "Gabriel", "Grace", "Hana", "Hassan", "Ishaan", "Isabella",
  "Jacob", "Julia", "Kabir", "Kavya", "Liam", "Lucas", "Maya", "Meera", "Nadia", "Noah",
  "Olivia", "Omar", "Priya", "Rahul", "Ravi", "Sofia", "Sanya", "Thomas", "Vikram", "Zara",
];

const LAST_NAMES = [
  "Agarwal", "Anderson", "Bakshi", "Bennett", "Brown", "Chen", "Clark", "Das", "Desai", "Evans",
  "Fernandes", "Garcia", "Gupta", "Hansen", "Iyer", "Johnson", "Kapoor", "Khan", "Kumar", "Lee",
  "Mehta", "Miller", "Mishra", "Nair", "Novak", "Okafor", "Patel", "Reddy", "Rossi", "Schmidt",
  "Sharma", "Singh", "Smith", "Tanaka", "Taylor", "Verma", "Wang", "Williams", "Yadav", "Zimmerman",
];

const TITLES: { title: string; department: string; seniority: string; designation: string }[] = [
  { title: "Chief Executive Officer", department: "Executive", seniority: "C-Suite", designation: "CEO" },
  { title: "Chief Technology Officer", department: "Engineering", seniority: "C-Suite", designation: "CTO" },
  { title: "Chief Financial Officer", department: "Finance", seniority: "C-Suite", designation: "CFO" },
  { title: "Chief Operating Officer", department: "Operations", seniority: "C-Suite", designation: "COO" },
  { title: "Vice President, Sales", department: "Sales", seniority: "VP", designation: "VP Sales" },
  { title: "Vice President, Marketing", department: "Marketing", seniority: "VP", designation: "VP Marketing" },
  { title: "Vice President, Engineering", department: "Engineering", seniority: "VP", designation: "VP Engineering" },
  { title: "Director of Sales", department: "Sales", seniority: "Director", designation: "Director" },
  { title: "Director of Marketing", department: "Marketing", seniority: "Director", designation: "Director" },
  { title: "Director of Human Resources", department: "Human Resources", seniority: "Director", designation: "Director" },
  { title: "Head of Procurement", department: "Procurement", seniority: "Head", designation: "Head" },
  { title: "Head of Partnerships", department: "Business Development", seniority: "Head", designation: "Head" },
  { title: "Engineering Manager", department: "Engineering", seniority: "Manager", designation: "Manager" },
  { title: "Sales Manager", department: "Sales", seniority: "Manager", designation: "Manager" },
  { title: "Product Manager", department: "Product", seniority: "Manager", designation: "Manager" },
  { title: "Senior Software Engineer", department: "Engineering", seniority: "Senior", designation: "Senior Engineer" },
  { title: "Data Scientist", department: "Data", seniority: "Mid", designation: "Individual Contributor" },
  { title: "Financial Analyst", department: "Finance", seniority: "Mid", designation: "Individual Contributor" },
  { title: "Talent Acquisition Specialist", department: "Human Resources", seniority: "Mid", designation: "Individual Contributor" },
  { title: "Marketing Associate", department: "Marketing", seniority: "Junior", designation: "Individual Contributor" },
  { title: "Operations Coordinator", department: "Operations", seniority: "Junior", designation: "Individual Contributor" },
  { title: "Customer Success Manager", department: "Customer Success", seniority: "Manager", designation: "Manager" },
];

export interface SampleDataset {
  version: string;
  companies: Company[];
  contacts: Contact[];
  contactsByCompany: Map<string, Contact[]>;
  /**
   * Contacts the preview keeps WITHOUT an employer, keyed by the company id whose
   * name they claimed. Present so the "review the uncertain ones" interface has
   * something real to render in the demo — production fills this from
   * `unassigned/<version>/…` objects.
   */
  unassignedByCompany: Map<string, UnassignedContact[]>;
  /** Which logical source file a record came from (`csv1` / `csv2`). */
  sources: string[];
}

/**
 * Association verdict for one synthetic contact.
 *
 * Computed with the SAME function the indexer uses (`associateContact`), against
 * a single candidate, because a synthetic company row carries its own domain —
 * exactly the shape of the real `csv1` records. Producing these labels by hand
 * would let the demo disagree with the pipeline about what "verified" means.
 */
function sampleAssociation(company: Company, claimedRef = 0): AssociationRecord {
  const candidate: AssociationCandidate = {
    ref: claimedRef,
    id: company.id,
    name: company.name,
    normalizedName: company.normalizedName,
    domain: company.domain ?? null,
    linkedinUrl: company.linkedinUrl ?? null,
    country: company.country ?? null,
    state: company.state ?? null,
    city: company.city ?? null,
    hasStrongIdentity: Boolean(company.domain ?? company.linkedinUrl),
  };
  return associateContact({ contact: {}, claimedRef, claimedIdentity: true, candidates: [candidate] }).record;
}

/** Deliberately unresolved sample contacts, for the review flow. */
const UNRESOLVED_PER_FAMILY = 2;
/** How many shared-name families get preserved contacts (keeps the demo small). */
const UNRESOLVED_FAMILIES = 4;

function buildRandomName(rng: () => number): string {
  const stem = STEMS[Math.floor(rng() * STEMS.length)];
  const word = INDUSTRY_WORDS[Math.floor(rng() * INDUSTRY_WORDS.length)];
  const suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
  return `${stem} ${word} ${suffix}`;
}

/** Generate the whole sample dataset once (memoised by the module). */
export function buildSampleDataset(companyTarget = 800): SampleDataset {
  const rng = mulberry32(20261015);
  const companies: Company[] = [];
  const contacts: Contact[] = [];
  const contactsByCompany = new Map<string, Contact[]>();
  let rowCounter = 0;

  const pushCompany = (
    seed: Omit<Seed, "size" | "revenue"> & { size?: string; revenue?: string },
    id: string,
    source: string,
  ) => {
    const primary = normalizeName(seed.name);
    const company: Company = {
      id,
      name: seed.name,
      normalizedName: primary,
      aliases: nameVariants(seed.name).filter((v) => v !== primary),
      domain: seed.domain,
      website: `https://${seed.domain}`,
      linkedinUrl: `https://www.linkedin.com/company/${seed.domain.split(".")[0]}`,
      industry: seed.industry,
      country: seed.country,
      city: seed.city,
      companySize: seed.size ?? SIZES[Math.floor(rng() * SIZES.length)],
      revenue: seed.revenue ?? REVENUES[Math.floor(rng() * REVENUES.length)],
      contactCount: 0,
      sources: [{ source, row: ++rowCounter }],
    };
    companies.push(company);
    return company;
  };

  // 1. Recognisable seeds, split across the two logical source files.
  SEEDS.forEach((seed, index) => {
    const source = index % 2 === 0 ? "csv1" : "csv2";
    pushCompany(seed, companyId(`d:${seed.domain}`), source);
  });

  // 2. Synthetic companies so the interface has realistic volume.
  while (companies.length < companyTarget) {
    const location = COUNTRIES[Math.floor(rng() * COUNTRIES.length)];
    const name = buildRandomName(rng);
    const domain = `${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)}.example`;
    if (companies.some((c) => c.domain === domain)) continue;
    pushCompany(
      {
        name,
        domain,
        industry: INDUSTRY_WORDS[Math.floor(rng() * INDUSTRY_WORDS.length)],
        country: location.country,
        city: location.cities[Math.floor(rng() * location.cities.length)],
      },
      companyId(`d:${domain}`),
      rng() > 0.45 ? "csv2" : "csv1",
    );
  }

  // 3. Contacts per company, with a realistic spread of coverage.
  companies.forEach((company) => {
    const list: Contact[] = [];
    const count = 4 + Math.floor(rng() * 34);
    for (let i = 0; i < count; i += 1) {
      const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
      const role = TITLES[Math.floor(rng() * TITLES.length)];
      const hasEmail = rng() > 0.22;
      const hasPhone = rng() > 0.55;
      const hasLinkedin = rng() > 0.3;
      const city = company.city ?? "Unknown";
      const email = hasEmail
        ? `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "") + `@${company.domain!.replace(/^www\./, "")}`
        : undefined;
      const contact: Contact = {
        id: contactId(`${company.id}|${first} ${last}|${role.title}|${i}`),
        companyId: company.id,
        fullName: `${first} ${last}`,
        firstName: first,
        lastName: last,
        title: role.title,
        designation: role.designation,
        seniority: role.seniority,
        department: role.department,
        email,
        phone: hasPhone ? `+${1 + Math.floor(rng() * 90)}${Math.floor(100000000 + rng() * 899999999)}` : undefined,
        linkedinUrl: hasLinkedin ? `https://www.linkedin.com/in/${first}-${last}-${i}`.toLowerCase() : undefined,
        country: company.country,
        city,
        source: { source: company.sources[0].source, row: ++rowCounter },
      };
      contact.association = sampleAssociation(company);
      list.push(contact);
    }
    contacts.push(...list);
    contactsByCompany.set(company.id, list);
    company.contactCount = list.length;
    const counts: AssociationCounts = { highConfidence: 0, plausible: 0, conflicting: 0, total: 0 };
    for (const contact of list) {
      if (contact.association?.category === "high_confidence") counts.highConfidence += 1;
      else if (contact.association?.category === "plausible") counts.plausible += 1;
      else if (contact.association?.category === "conflicting") counts.conflicting += 1;
      counts.total += 1;
    }
    company.associations = counts;
  });

  /*
   * 4. A few contacts whose employer genuinely cannot be resolved: their company
   *    name is shared by another record and they carry no distinguishing evidence.
   *    They are preserved under the name they claimed, exactly as the indexer
   *    writes them in `unassigned/`.
   */
  const unassignedByCompany = new Map<string, UnassignedContact[]>();
  const families = new Map<string, Company[]>();
  for (const company of companies) {
    const list = families.get(company.normalizedName);
    if (list) list.push(company);
    else families.set(company.normalizedName, [company]);
  }
  const shared = [...families.values()].filter((list) => list.length > 1).slice(0, UNRESOLVED_FAMILIES);
  for (const [familyIndex, family] of shared.entries()) {
    const company = family[0];
    const preserved: UnassignedContact[] = [];
    for (let i = 0; i < UNRESOLVED_PER_FAMILY; i += 1) {
      const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
      const role = TITLES[Math.floor(rng() * TITLES.length)];
      const contactIdValue = contactId(`unassigned|${familyIndex}|${i}`);
      preserved.push({
        id: contactIdValue,
        companyId: "",
        fullName: `${first} ${last}`,
        firstName: first,
        lastName: last,
        title: role.title,
        designation: role.designation,
        seniority: role.seniority,
        department: role.department,
        country: company.country,
        city: company.city,
        source: { source: company.sources[0].source, row: ++rowCounter },
        claimedCompanyName: company.name,
        claimedNormalizedName: company.normalizedName,
        association: {
          category: "unresolved",
          reason: "several_candidates_remain",
          evidence: { name: "shared", domain: "absent", country: "absent", rowIdentity: false, candidates: family.length },
          // Same bound the indexer applies to a stored record (see
          // `MAX_CANDIDATE_IDS`), so the preview cannot show a shape production
          // never writes.
          candidateCompanyIds: family.slice(0, MAX_CANDIDATE_IDS).map((member) => member.id),
          candidateCount: family.length,
        },
      });
    }
    unassignedByCompany.set(company.id, preserved);
  }

  return {
    version: SAMPLE_DATASET_VERSION,
    companies,
    contacts,
    contactsByCompany,
    unassignedByCompany,
    sources: ["csv1", "csv2"],
  };
}

let cached: SampleDataset | null = null;

export function getSampleDataset(): SampleDataset {
  if (!cached) cached = buildSampleDataset();
  return cached;
}

/** Facet counts computed from real sample rows (never hard-coded). */
export function buildFacets(list: Contact[]): {
  designations: FacetBucket[];
  departments: FacetBucket[];
  seniority: FacetBucket[];
  countries: FacetBucket[];
  cities: FacetBucket[];
  emailAvailable: number;
  linkedinAvailable: number;
} {
  const tally = (pick: (c: Contact) => string | undefined) => {
    const map = new Map<string, number>();
    for (const contact of list) {
      const value = pick(contact);
      if (value) map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };
  return {
    designations: tally((c) => c.designation),
    departments: tally((c) => c.department),
    seniority: tally((c) => c.seniority),
    countries: tally((c) => c.country),
    cities: tally((c) => c.city),
    emailAvailable: list.filter((c) => c.email).length,
    linkedinAvailable: list.filter((c) => c.linkedinUrl).length,
  };
}

/** Kept as a named export for existing callers; the rule lives in one place. */
export function contactMatchesFilters(contact: Contact, filters?: ContactFilters): boolean {
  return sharedContactMatchesFilters(contact, filters);
}
