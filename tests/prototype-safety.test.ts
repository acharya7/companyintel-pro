/**
 * Regression tests for inherited-property lookups.
 *
 * Found on the real dataset, not in theory: the first 20,000 organization rows
 * included a company whose name contains the token "constructor". Because
 * `ABBREVIATIONS` (and later the indexer's term map, and the Worker's shard
 * lookup) were plain object literals, `ABBREVIATIONS["constructor"]` returned
 * `Object.prototype.constructor` — a function — and the run died with
 * `expansion.split is not a function`, and then with
 * `undefined is not an object (evaluating 'postings.refs.push')`.
 *
 * Every dynamic-key lookup on a plain object in the pipeline is covered here.
 */

import { describe, expect, test } from "bun:test";

import { expandAbbreviations, nameVariants, normalizeName, tokenize } from "../src/shared/normalize";
import { contactsFor, postingsFor, type ContactPartitionPayload, type ShardPayload } from "../src/shared/search/index-format";
import { LocalCandidateSource } from "../src/shared/search/local-index";
import { searchCompanies } from "../src/shared/search/engine";
import type { Company } from "../src/shared/models";

const INHERITED_KEYS = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "prototype"];

describe("normalizer survives names that collide with Object.prototype", () => {
  test("abbreviation expansion treats an inherited key as a plain token", () => {
    for (const key of INHERITED_KEYS) {
      expect(expandAbbreviations([key])).toEqual([key]);
    }
    expect(expandAbbreviations(["intl", "constructor"])).toEqual(["international", "constructor"]);
  });

  test("a company called \"Constructor Software\" normalizes and indexes normally", () => {
    expect(normalizeName("Constructor Software Ltd")).toBe("constructor software");
    const variants = nameVariants("Constructor Ltd");
    expect(variants).toContain("constructor");
    expect(variants.every((variant) => typeof variant === "string")).toBe(true);
    expect(tokenize("Constructor Group")).toEqual(["constructor", "group"]);
  });
});

describe("index lookups never read through Object.prototype", () => {
  test("postingsFor ignores an inherited key and returns real postings otherwise", () => {
    const payload: ShardPayload = { terms: { microsoft: { refs: [1], q: [10] } } };
    expect(postingsFor(payload, "microsoft")).toEqual({ refs: [1], q: [10] });
    for (const key of INHERITED_KEYS) expect(postingsFor(payload, key)).toBeUndefined();
    expect(postingsFor(null, "microsoft")).toBeUndefined();
    expect(postingsFor(undefined, "constructor")).toBeUndefined();
  });

  test("contactsFor ignores an inherited ref and returns real contacts otherwise", () => {
    const payload: ContactPartitionPayload = { firstRef: 0, byCompany: { "7": [{ id: "p_1" }] } };
    expect(contactsFor(payload, 7)).toEqual([{ id: "p_1" }]);
    expect(contactsFor(payload, 8)).toBeUndefined();
    expect(contactsFor(null, 7)).toBeUndefined();
  });

  test("a search for a name that collides with Object.prototype still works", async () => {
    const company: Company = {
      id: "c_constructor",
      name: "Constructor Group",
      normalizedName: "constructor group",
      contactCount: 3,
      sources: [{ source: "csv1", row: 2 }],
    };
    const source = new LocalCandidateSource([company], "v-test");

    const exact = await searchCompanies(source, "constructor group");
    expect(exact.hits.map((hit) => hit.name)).toEqual(["Constructor Group"]);

    const partial = await searchCompanies(source, "constructor");
    expect(partial.hits.length).toBe(1);

    // The token/gram document-frequency map is the other place a plain object
    // would have answered from the prototype chain.
    const stats = await source.stats();
    expect(stats.df["constructor"]).toBeGreaterThan(0);

    for (const key of INHERITED_KEYS) {
      const response = await searchCompanies(source, key);
      expect(Array.isArray(response.hits)).toBe(true);
    }
  });
});
