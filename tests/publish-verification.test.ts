/**
 * Activation safety: nothing may become the active version without R2 saying it is
 * complete.
 *
 * The CLI used to validate against the LOCAL output directory and then flip the
 * pointer. Two failures followed from that, both ending with the application serving
 * nothing: the local output can have been deleted since the upload (that is exactly
 * what happens after a disk cleanup), and a version can be half-uploaded. These
 * tests pin the check that closes both — the uploaded manifest must exist, describe
 * the same version and record a passed validation, and the uploaded validation
 * report must agree.
 */

import { describe, expect, test } from "bun:test";

import { verifyRemoteVersion } from "../tools/indexer/src/build";

type ObjectBody = Record<string, unknown>;

/** A client with the two methods `verifyRemoteVersion` uses. */
function fakeClient(objects: Record<string, ObjectBody>) {
  const gets: string[] = [];
  return {
    gets,
    async get(key: string) {
      gets.push(key);
      const body = objects[key];
      return {
        ok: body !== undefined,
        json: async () => body,
      };
    },
  };
}

const manifest = (overrides: ObjectBody = {}) => ({
  version: "v-test",
  validationPassed: true,
  objectCount: 42,
  bytes: 1024,
  ...overrides,
});

describe("activation refuses an unverified version", () => {
  test("a complete, validated version passes and reports its size", async () => {
    const client = fakeClient({
      "manifests/v-test/manifest.json": manifest(),
      "manifests/v-test/validation.json": { version: "v-test", passed: true },
    });
    await expect(verifyRemoteVersion(client, "v-test")).resolves.toEqual({ objectCount: 42, bytes: 1024 });
    expect(client.gets).toEqual(["manifests/v-test/manifest.json", "manifests/v-test/validation.json"]);
  });

  test("a version that was never uploaded is refused", async () => {
    const client = fakeClient({});
    await expect(verifyRemoteVersion(client, "v-missing")).rejects.toThrow(/not complete in R2/);
  });

  test("a version whose validation report never reached R2 is refused", async () => {
    const client = fakeClient({ "manifests/v-test/manifest.json": manifest() });
    await expect(verifyRemoteVersion(client, "v-test")).rejects.toThrow(/no uploaded validation report/);
  });

  test("a version whose uploaded validation failed is refused", async () => {
    const client = fakeClient({
      "manifests/v-test/manifest.json": manifest({ validationPassed: false }),
      "manifests/v-test/validation.json": { version: "v-test", passed: false },
    });
    await expect(verifyRemoteVersion(client, "v-test")).rejects.toThrow(/FAILED validation/);

    // Even when the manifest claims success, the report is what counts.
    const inconsistent = fakeClient({
      "manifests/v-test/manifest.json": manifest(),
      "manifests/v-test/validation.json": { version: "v-test", passed: false },
    });
    await expect(verifyRemoteVersion(inconsistent, "v-test")).rejects.toThrow(/did not pass the validation report stored in R2/);
  });

  test("a manifest that describes a different version is refused", async () => {
    const client = fakeClient({
      "manifests/v-test/manifest.json": manifest({ version: "v-other" }),
      "manifests/v-test/validation.json": { version: "v-other", passed: true },
    });
    await expect(verifyRemoteVersion(client, "v-test")).rejects.toThrow(/describes version v-other/);
  });
});
