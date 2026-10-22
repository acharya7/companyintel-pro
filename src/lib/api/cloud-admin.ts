/**
 * Client boundary for the Access-protected cloud admin API.
 *
 * `loadJobs` never throws: a 401/403 is an authorisation answer ("denied"), any
 * other failure is a diagnostic ("error"). That distinction is what keeps the
 * launch control honest — it is rendered only for an identity the control plane
 * accepted, and a malformed or failed listing can never be mistaken for approval.
 */

import { normalizeJobsResponse, type JobsView } from "@/shared/cloud/job-view";

/** A control-plane failure keeps its HTTP status: 401/403 means "not an administrator". */
export class AdminError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminError";
    this.status = status;
  }
}

export async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-companyintel-cloud-admin": "dev",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new AdminError(body?.error?.message ?? `Request failed (${response.status})`, response.status);
  return body;
}

export type JobsLoadResult =
  | { kind: "ok"; view: JobsView }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export async function loadJobs(fetcher: typeof fetch = fetch): Promise<JobsLoadResult> {
  let response: Response;
  try {
    response = await fetcher("/api/cloud/jobs", {
      headers: { "content-type": "application/json", "x-companyintel-cloud-admin": "dev" },
    });
  } catch (caught) {
    return { kind: "error", message: `The control plane could not be reached: ${caught instanceof Error ? caught.message : String(caught)}` };
  }

  let payload: unknown = null;
  let parseError: string | null = null;
  try {
    payload = await response.json();
  } catch (caught) {
    parseError = caught instanceof Error ? caught.message : String(caught);
  }

  if (!response.ok) {
    const message = (payload as { error?: { message?: string } } | null)?.error?.message;
    const detail = message ?? `Request failed (${response.status})`;
    if (response.status === 401 || response.status === 403) return { kind: "denied", message: detail };
    return { kind: "error", message: detail };
  }

  if (parseError !== null) {
    return { kind: "error", message: `The control plane returned a response that is not JSON (HTTP ${response.status}): ${parseError}` };
  }

  return { kind: "ok", view: normalizeJobsResponse(payload) };
}
