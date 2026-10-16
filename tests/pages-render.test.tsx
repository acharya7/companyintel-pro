/**
 * Page render tests — the pages that were broken in the preview.
 *
 * HONEST SCOPE: this is **not** a browser test. It renders each page with
 * `react-dom/server` inside the real providers (React Query + router) and asserts
 * what the markup contains for each dataset mode. There is no browser engine in
 * this environment, so DOM events, layout, mobile breakpoints and hydration are
 * NOT exercised here — the manual checklist in `docs/verification.md` covers those
 * on your machine.
 *
 * What it does catch is exactly the failure that shipped: a page whose data hook
 * calls an API method that does not exist at runtime throws during render, and the
 * screen shows "Request failed — api.datasetStatus is not a function" instead of
 * content. Because the query cache is pre-seeded here, the hooks resolve to data
 * and the page renders its real states: loading, error, demo, live and
 * no-dataset.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Dashboard from "../src/pages/Dashboard";
import DatasetManagement from "../src/pages/DatasetManagement";
import CompanySearch from "../src/pages/CompanySearch";
import { Pager } from "../src/components/common";
import { queryKeys } from "../src/hooks/use-api";
import type { DatasetStatusResponse, UserSettings } from "../src/shared/models";

/* --------------------------------- fixtures ------------------------------- */

function status(overrides: Partial<DatasetStatusResponse> = {}): DatasetStatusResponse {
  return {
    indexed: false,
    activeVersion: null,
    previousVersion: null,
    message: "Dataset not indexed. Run the local indexer and publish a validated version.",
    bucket: "company-intel-data",
    bucketOk: false,
    sources: [],
    versions: [],
    lastIndexedAt: null,
    indexing: null,
    dataOrigin: "r2",
    ...overrides,
  };
}

const noDataset = status();

const realDataset = status({
  indexed: true,
  activeVersion: "v1",
  bucketOk: true,
  message: "Active dataset version v1.",
  lastIndexedAt: "2026-10-16T04:50:25.593Z",
  sources: [
    { id: "csv1", key: "raw/", role: "organizations", sizeBytes: null, lastModified: null, verified: false },
    { id: "csv2", key: "raw/", role: "people", sizeBytes: null, lastModified: null, verified: false },
  ],
  versions: [
    {
      version: "v1",
      state: "validated",
      createdAt: "2026-10-16T04:48:27.325Z",
      completedAt: "2026-10-16T04:50:25.593Z",
      normalizerVersion: 1,
      indexFormatVersion: 1,
      counters: {
        rowsRead: 39_505,
        rowsRejected: 1_376,
        uniqueCompanies: 20_265,
        uniqueContacts: 19_414,
        duplicateRowsResolved: 2,
        duplicateCompaniesResolved: 0,
        ambiguousCompanies: 220,
        recordsMissingCompanyId: 19_562,
        perSource: {
          csv1: { rowsRead: 19_505, rowsRejected: 900, companies: 18_586, contacts: 0 },
          csv2: { rowsRead: 20_000, rowsRejected: 476, companies: 1_679, contacts: 19_414 },
        },
      },
      bytes: 10_407_235,
      objectCount: 1_826,
      validationPassed: true,
    },
  ],
});

const demoDataset = status({
  dataOrigin: "sample",
  message: "No dataset indexed in R2. The sample dataset is active for interface preview only.",
  bucketError: "Preview mode: the browser cannot reach the private R2 bucket.",
  sources: [
    { id: "csv1", key: "raw/file1.csv", role: "organizations", sizeBytes: null, lastModified: null, verified: false },
    { id: "csv2", key: "raw/file2.csv", role: "people", sizeBytes: null, lastModified: null, verified: false },
  ],
});

const settings: UserSettings = {
  fuzzyByDefault: true,
  pageSize: 25,
  theme: "system",
  cacheEnabled: true,
  cacheTtlMinutes: 30,
  redactContactCache: true,
} as UserSettings;

/* --------------------------------- helpers -------------------------------- */

async function makeClient(seed: { datasetStatus?: DatasetStatusResponse; error?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      // No mount refetch: the seeded state (data or error) is the state under test,
      // so the assertion is about the page, not about a retry that is in flight.
      queries: {
        retry: false,
        retryOnMount: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  if (seed.error) {
    // Store a real error in the cache (awaited), so the page renders its error state.
    await client
      .fetchQuery({ queryKey: queryKeys.datasetStatus, queryFn: () => Promise.reject(new Error(seed.error)) })
      .catch(() => undefined);
  } else if (seed.datasetStatus) {
    client.setQueryData(queryKeys.datasetStatus, seed.datasetStatus);
    client.setQueryData(queryKeys.datasetStats, null);
    client.setQueryData(queryKeys.leads, { leads: [], total: 0 });
    client.setQueryData(queryKeys.savedSearches, []);
    client.setQueryData(queryKeys.activity, []);
    client.setQueryData(queryKeys.exports, []);
    client.setQueryData(queryKeys.settings, settings);
  }
  return client;
}

async function renderPage(
  ui: React.ReactElement,
  options: { path?: string; seed?: { datasetStatus?: DatasetStatusResponse; error?: string } } = {},
): Promise<string> {
  const client = await makeClient(options.seed);
  return renderToString(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.path ?? "/"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ---------------------------------- tests --------------------------------- */

describe("pages render without a missing API method", () => {
  test("Dashboard renders in no-dataset mode and says so", async () => {
    const html = await renderPage(<Dashboard />, { seed: { datasetStatus: noDataset } });
    expect(html).toContain("Dashboard");
    expect(html).toContain("Dataset not indexed");
    // No fabricated figures: statistics have not been generated.
    expect(html).toContain("Statistics not generated yet");
    expect(html).not.toContain("is not a function");
  });

  test("Dashboard renders in demo mode and labels the sample dataset", async () => {
    const html = await renderPage(<Dashboard />, { seed: { datasetStatus: demoDataset } });
    expect(html).toContain("Dashboard");
    expect(html).toContain("Sample");
    expect(html).not.toContain("is not a function");
  });

  test("Dashboard renders in real-data mode with the published version", async () => {
    const html = await renderPage(<Dashboard />, { seed: { datasetStatus: realDataset } });
    expect(html).toContain("v1");
    expect(html).toContain("R2 index");
    expect(html).not.toContain("is not a function");
  });

  test("Dashboard shows its loading state before the status resolves", async () => {
    const html = await renderPage(<Dashboard />);
    expect(html).toContain("Loading dataset state…");
  });

  test("Dashboard shows a readable error, not a crash, when status fails", async () => {
    const html = await renderPage(<Dashboard />, { seed: { error: "Network unreachable" } });
    expect(html).toContain("Request failed");
    expect(html).toContain("Network unreachable");
  });

  test("Dataset management renders the mode banner and never invents a version", async () => {
    const noData = await renderPage(<DatasetManagement />, { seed: { datasetStatus: noDataset } });
    expect(noData).toContain("Dataset management");
    expect(noData).toContain("No dataset indexed");
    expect(noData).toContain("Nothing published");
    expect(noData).not.toContain("is not a function");

    const real = await renderPage(<DatasetManagement />, { seed: { datasetStatus: realDataset } });
    expect(real).toContain("v1");
    expect(real).toContain("Live data");
  });

  test("Company search explains the no-dataset state instead of failing", async () => {
    const html = await renderPage(<CompanySearch />, { path: "/companies?q=microsoft", seed: { datasetStatus: noDataset } });
    expect(html).toContain("No dataset indexed");
    expect(html).toContain("Dataset management");
    expect(html).not.toContain("is not a function");
  });

  test("Company search renders its search surface in demo mode", async () => {
    const html = await renderPage(<CompanySearch />, { path: "/companies?q=microsoft", seed: { datasetStatus: demoDataset } });
    expect(html).toContain("microsoft");
    // The no-dataset explanation must NOT appear when a dataset is being served.
    expect(html).not.toContain("No dataset indexed");
  });

  test("Company search renders without a query and without a dataset status", async () => {
    const html = await renderPage(<CompanySearch />, { path: "/companies" });
    expect(html).toContain("Search the company index");
  });
});

/**
 * The completeness signal the search engine reports (`totalIsLowerBound`) has to
 * reach the user as a *number that does not claim to be exhaustive*. That is a
 * one-line UI contract, and it is asserted here rather than assumed: a total the
 * engine says is a floor renders as "of 40+", an exact total as "of 40".
 */
describe("search completeness shown to the user", () => {
  const pager = (totalIsLowerBound?: boolean) =>
    renderToString(
      <Pager page={1} pageSize={25} total={40} hasMore totalIsLowerBound={totalIsLowerBound} onPage={() => {}} />,
    );

  test("a lower-bound total renders as N+, an exact total does not", () => {
    expect(pager(true)).toContain("of 40+");
    const exact = pager(false);
    expect(exact).toContain("of 40");
    expect(exact).not.toContain("of 40+");
  });

  test("a total of zero is an answer, not a lower bound", () => {
    expect(pager(true)).not.toContain("No results");
    expect(
      renderToString(<Pager page={1} pageSize={25} total={0} hasMore={false} onPage={() => {}} />),
    ).toContain("No results");
  });
});
