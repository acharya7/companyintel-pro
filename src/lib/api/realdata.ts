/**
 * Browser client for REAL DATA provenance and bounded source scans.
 *
 * Deliberately separate from `ApiClient`: these routes only exist on the deployed
 * Worker (they need the container binding and Cloudflare Access). The preview's
 * synthetic sample dataset has no real-data coverage, and the UI hides the panel
 * when this client answers "not available" instead of inventing numbers.
 */

import { apiBaseUrl } from "./client";
import type {
  RealDataCoverageResponse,
  RealDataScanKind,
  RealDataScanResponse,
  RealDataScanStartResponse,
} from "@/shared/realdata/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `The real-data API answered HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body as T;
}

export function getRealDataCoverage(): Promise<RealDataCoverageResponse> {
  return request<RealDataCoverageResponse>("/api/realdata/coverage");
}

export function startSourceScan(body: {
  q: string;
  kind?: RealDataScanKind;
  maxMb?: number;
  force?: boolean;
}): Promise<RealDataScanStartResponse> {
  return request<RealDataScanStartResponse>("/api/realdata/scan", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getSourceScan(jobId: string): Promise<RealDataScanResponse> {
  return request<RealDataScanResponse>(`/api/realdata/scan/${encodeURIComponent(jobId)}`);
}

export function cancelSourceScan(jobId: string): Promise<{ cancelled: boolean; jobId: string; message?: string }> {
  return request(`/api/realdata/scan/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: "{}" });
}
