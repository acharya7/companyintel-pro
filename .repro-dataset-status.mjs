/**
 * Throwaway reproduction of the preview failure (deleted right after use).
 * Prints which ApiClient methods actually exist on the wrapped client at runtime.
 */
import { createApiClient } from "./src/lib/api/client.ts";

const api = createApiClient();
const names = [
  "health",
  "datasetStatus",
  "datasetSources",
  "datasetStats",
  "validateDataset",
  "activateDataset",
  "searchCompanies",
  "getCompany",
  "getCompanyContacts",
  "listContacts",
  "getContact",
  "listLeads",
  "saveLead",
  "updateLead",
  "deleteLead",
  "listSavedSearches",
  "createSavedSearch",
  "deleteSavedSearch",
  "markSavedSearchRun",
  "getSettings",
  "updateSettings",
  "listActivity",
  "recordActivity",
  "listExports",
  "createExport",
  "getExport",
  "downloadExport",
];

const missing = names.filter((name) => typeof api[name] !== "function");
console.log("mode:", api.mode, "| prototype of wrapper:", Object.getPrototypeOf(api) === Object.prototype ? "plain object" : "custom");
console.log("present:", names.length - missing.length, "/", names.length);
console.log("MISSING:", missing.join(", ") || "(none)");
