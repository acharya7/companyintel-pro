import { describe, expect, test } from "bun:test";
import {
  NORMALIZER_VERSION,
  compact,
  expandAbbreviations,
  genericTokenRatio,
  identityKey,
  isStrongIdentity,
  nameVariants,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
  normalizePhone,
  tokenize,
} from "../src/shared/normalize";

describe("tokenize", () => {
  test("lowercases, deaccents and splits on punctuation", () => {
    // Periods are removed, not spaced: "S.A." is one token, not three.
    expect(tokenize("Nestlé S.A.")).toEqual(["nestle", "sa"]);
    expect(tokenize("Amazon.com, Inc.")).toEqual(["amazoncom", "inc"]);
    expect(tokenize("U.S. Bancorp")).toEqual(["us", "bancorp"]);
    expect(tokenize("JPMorgan Chase & Co.")).toEqual(["jpmorgan", "chase", "and", "co"]);
  });

  test("keeps apostrophes inside a word", () => {
    expect(tokenize("McDonald's Restaurants")).toEqual(["mcdonalds", "restaurants"]);
    expect(tokenize("O'Brien Systems")).toEqual(["obrien", "systems"]);
  });

  test("collapses repeated whitespace and unicode spaces", () => {
    expect(tokenize("  Tata   Consultancy\u00a0Services ")).toEqual(["tata", "consultancy", "services"]);
  });

  test("handles digits and hyphenated names", () => {
    expect(tokenize("7-Eleven Inc")).toEqual(["7", "eleven", "inc"]);
    expect(tokenize("Hewlett-Packard")).toEqual(["hewlett", "packard"]);
  });

  test("returns an empty array for empty or symbol-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("***")).toEqual([]);
  });
});

describe("normalizeName", () => {
  test("is idempotent", () => {
    for (const name of ["Infosys Limited", "Nestlé S.A.", "Tata Consultancy Services Limited"]) {
      const once = normalizeName(name);
      expect(normalizeName(once)).toBe(once);
    }
  });

  test("strips trailing legal forms so suffix variants converge", () => {
    expect(normalizeName("Infosys Ltd")).toBe("infosys");
    expect(normalizeName("Infosys Limited")).toBe("infosys");
    expect(normalizeName("Infosys Pvt Ltd")).toBe("infosys");
  });

  test("strips several trailing legal tokens", () => {
    expect(normalizeName("Vertex Analytics Private Limited")).toBe("vertex analytics");
    expect(normalizeName("Global Solutions International Pvt Ltd")).toBe("global solutions international");
  });

  test("never strips a token when it is the whole name", () => {
    expect(normalizeName("Limited")).toBe("limited");
    expect(normalizeName("Inc")).toBe("inc");
  });

  test("keeps leading name tokens that merely look like suffixes", () => {
    expect(normalizeName("Limited Brands Inc")).toBe("limited brands");
  });

  test("collapses case, whitespace, accents and punctuation", () => {
    const forms = ["Microsoft Corporation", "  microsoft   corp. ", "MICROSOFT CORP", "Microsoft  Corp"];
    const normalized = forms.map(normalizeName);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("microsoft");
  });

  test("normalizer version is recorded", () => {
    expect(NORMALIZER_VERSION).toBeGreaterThan(0);
  });
});

describe("nameVariants", () => {
  test("produces primary, unstripped, abbreviation-expanded and compact forms", () => {
    const variants = nameVariants("Infosys Ltd");
    expect(variants).toContain("infosys");
    expect(variants).toContain("infosys ltd");
    expect(variants).toContain("infosys limited");
    expect(variants).toContain("infosysltd");
  });

  test("deduplicates and preserves stable order", () => {
    const variants = nameVariants("Alphabet Inc");
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants[0]).toBe("alphabet");
  });

  test("expands known abbreviations", () => {
    expect(expandAbbreviations(["intl", "business"])).toEqual(["international", "business"]);
    expect(nameVariants("Intl Business Machines")).toContain("international business machines");
  });

  test("returns nothing for an empty name", () => {
    expect(nameVariants("   ")).toEqual([]);
  });
});

describe("attribute normalization", () => {
  test("domains", () => {
    expect(normalizeDomain("https://www.Microsoft.com/about?x=1")).toBe("microsoft.com");
    expect(normalizeDomain("HTTP://WWW.TCS.CO.IN/")).toBe("tcs.co.in");
    expect(normalizeDomain("microsoft.com:8443")).toBe("microsoft.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("n/a")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  test("linkedin", () => {
    expect(normalizeLinkedin("https://www.linkedin.com/company/tata-consultancy-services/")).toBe(
      "linkedin.com/company/tata-consultancy-services",
    );
    expect(normalizeLinkedin("linkedin.com/in/someone")).toBe("linkedin.com/in/someone");
    expect(normalizeLinkedin("")).toBeNull();
  });

  test("email and phone", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizePhone("+1 (415) 555-0132")).toBe("+14155550132");
    expect(normalizePhone("12")).toBeNull();
  });
});

describe("identity keys", () => {
  test("prefers strongest evidence then falls back to name", () => {
    expect(identityKey({ domain: "https://www.ibm.com/x", name: "IBM" })).toBe("d:ibm.com");
    expect(identityKey({ linkedinUrl: "https://linkedin.com/company/ibm", name: "IBM" })).toBe("l:linkedin.com/company/ibm");
    expect(identityKey({ sourceId: "SRC-123", name: "IBM" })).toBe("s:src-123");
    expect(identityKey({ name: "IBM Corporation" })).toBe("n:ibm");
  });

  test("only domain / linkedin / source id count as strong identity", () => {
    expect(isStrongIdentity("d:ibm.com")).toBe(true);
    expect(isStrongIdentity("n:ibm")).toBe(false);
  });
});

describe("helpers", () => {
  test("compact removes spaces", () => {
    expect(compact("tata consultancy services")).toBe("tataconsultancyservices");
  });

  test("generic token ratio", () => {
    expect(genericTokenRatio(["solutions"])).toBe(1);
    expect(genericTokenRatio(["tata", "consultancy"])).toBe(0);
    expect(genericTokenRatio([])).toBe(0);
  });
});
