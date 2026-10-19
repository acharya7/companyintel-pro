/**
 * Cost forecast for a full cloud run, derived from a measured benchmark.
 *
 * Everything here is arithmetic on a measurement plus an explicitly labelled
 * allowance. It is NOT a bill: Cloudflare bills in 10 ms increments, free-tier
 * allowances are monthly, and Pass 2's container time is estimated rather than
 * measured at full scale. The three scenarios exist so the decision is made on
 * a range instead of a single optimistic number.
 */

import { CONTAINER_PRICE, R2_PRICES } from "./pass1";

/** Workers Paid monthly allowances that a single indexing job can consume. */
export const INCLUDED = {
  containerVcpuMinutes: 375,
  containerGibHours: 25,
  containerDiskGbHours: 200,
  classA: 1_000_000,
  classB: 10_000_000,
} as const;

export interface BenchmarkMeasurement {
  /** Source bytes actually processed. */
  sourceBytes: number;
  /** Wall seconds for that work in the benchmark process. */
  seconds: number;
  rows: number;
  rejected: number;
  segmentBytes: number;
  segments: number;
  /** R2 requests issued while processing. */
  classA: number;
  classB: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface Forecast {
  scenario: "low" | "expected" | "high";
  containers: number;
  pass1: {
    sourceBytes: number;
    spoolBytes: number;
    segments: number;
    wallSeconds: number;
    vcpuSeconds: number;
    gibSeconds: number;
    diskGbSeconds: number;
    classA: number;
    classB: number;
  };
  pass2: {
    wallSeconds: number;
    vcpuSeconds: number;
    gibSeconds: number;
    diskGbSeconds: number;
    inputBytes: number;
    outputBytes: number;
    classA: number;
    classB: number;
  };
  storageGbMonths: number;
  billableUsd: number;
  grossUsd: number;
  breakdown: { computeUsd: number; r2RequestsUsd: number; storageUsd: number };
  notes: string[];
}

export interface ForecastOptions {
  containers?: number;
  corpusBytes: number;
  corpusRows: number;
  /** Final index size estimate (the local preflight's own upper bound). */
  outputBytes?: number;
  /** Pass 2 is estimated as this multiple of Pass 1 container seconds. */
  pass2Multiplier?: number;
  /** Container used for Pass 2 (defaults to standard-2: 1 vCPU, 6 GiB, 12 GB disk). */
  pass2Instance?: { vcpu: number; gib: number; diskGb: number };
}

const DEFAULT_CONTAINERS = 4;
const PASS1_DISK_GB = 8;

export function forecast(
  measured: BenchmarkMeasurement,
  options: ForecastOptions,
  scenario: Forecast["scenario"] = "expected",
): Forecast {
  const notes: string[] = [];
  const containers = options.containers ?? DEFAULT_CONTAINERS;
  const corpusBytes = options.corpusBytes;
  const outputBytes = options.outputBytes ?? 20.3e9;

  // Throughput and expansion factors are the measured ones, adjusted per scenario.
  const speedFactor = scenario === "low" ? 1.5 : scenario === "high" ? 0.6 : 1;
  const expansionFactor = scenario === "high" ? 1.3 : 1;
  const pass2Multiplier = (options.pass2Multiplier ?? 3) * (scenario === "high" ? 2 : 1);

  const bytesPerSecond = measured.sourceBytes / Math.max(1, measured.seconds);
  const rowsPerSecond = measured.rows / Math.max(1, measured.seconds);
  const spoolRatio = measured.segmentBytes / Math.max(1, measured.sourceBytes);
  const segmentsPerByte = measured.segments / Math.max(1, measured.sourceBytes);
  const classAPerByte = measured.classA / Math.max(1, measured.sourceBytes);
  const classBPerByte = measured.classB / Math.max(1, measured.sourceBytes);

  const pass1Wall = corpusBytes / (bytesPerSecond * speedFactor * containers);
  const pass1Vcpu = pass1Wall * containers * CONTAINER_PRICE.vcpu;
  const pass1Gib = pass1Wall * containers * CONTAINER_PRICE.gib;
  const pass1Disk = pass1Wall * containers * PASS1_DISK_GB;
  const spoolBytes = corpusBytes * spoolRatio * expansionFactor;
  const segments = Math.ceil(corpusBytes * segmentsPerByte);

  const pass2Instance = options.pass2Instance ?? { vcpu: 1, gib: 6, diskGb: 12 };
  const pass2Containers = Math.max(1, Math.round(containers / 2));
  const pass2Wall = pass1Wall * pass2Multiplier * 2; // fewer, larger instances
  const pass2Vcpu = pass2Wall * pass2Containers * pass2Instance.vcpu;
  const pass2Gib = pass2Wall * pass2Containers * pass2Instance.gib;
  const pass2Disk = pass2Wall * pass2Containers * pass2Instance.diskGb;

  const classA = Math.ceil(corpusBytes * classAPerByte) + Math.ceil((outputBytes / 1.5e6) * 1.2);
  const classB = Math.ceil(corpusBytes * classBPerByte) + Math.ceil(outputBytes / 8e6) * 2;

  const computeUsd = Math.max(0, pass1Vcpu - INCLUDED.containerVcpuMinutes * 60) * CONTAINER_PRICE.vcpuPerSecond +
    Math.max(0, pass2Vcpu - INCLUDED.containerVcpuMinutes * 60) * CONTAINER_PRICE.vcpuPerSecond +
    Math.max(0, pass1Gib - INCLUDED.containerGibHours * 3600) * CONTAINER_PRICE.gibPerSecond +
    Math.max(0, pass2Gib - INCLUDED.containerGibHours * 3600) * CONTAINER_PRICE.gibPerSecond;
  // Disk has no per-second price in the published table beyond GB-hours; the
  // documented included allowance is 200 GB-hours, so only the excess is counted
  // at the published GB-second rate.
  const diskUsd =
    (Math.max(0, pass1Disk - INCLUDED.containerDiskGbHours * 3600) +
      Math.max(0, pass2Disk - INCLUDED.containerDiskGbHours * 3600)) *
    0.00000007;
  const r2RequestsUsd =
    (Math.max(0, classA - INCLUDED.classA) / 1e6) * R2_PRICES.classAPerMillion +
    (Math.max(0, classB - INCLUDED.classB) / 1e6) * R2_PRICES.classBPerMillion;
  const storageGbMonths = (spoolBytes * 2 + outputBytes) / 1e9;
  const storageUsd = Math.max(0, storageGbMonths - 10) * R2_PRICES.storagePerGbMonth;

  notes.push(
    `Pass 1: ${containers} × standard-1 (0.5 vCPU / 4 GiB / 8 GB disk), ${(corpusBytes / 1e9).toFixed(2)} GB at ` +
      `${((bytesPerSecond * speedFactor) / 1e6).toFixed(1)} MB/s per container (measured in this sandbox, not in a container).`,
  );
  notes.push(`Measured rows/s: ${rowsPerSecond.toFixed(0)}; spool expansion ${(spoolRatio * 100).toFixed(1)}% of source bytes.`);
  notes.push(
    `Pass 2: ${pass2Containers} × standard-2 (1 vCPU / 6 GiB / 12 GB), assumed ${pass2Multiplier}× Pass 1 wall time.`,
  );
  notes.push("Assumes the published Workers Paid monthly allowances are still available to this job.");

  return {
    scenario,
    containers,
    pass1: {
      sourceBytes: corpusBytes,
      spoolBytes,
      segments,
      wallSeconds: pass1Wall,
      vcpuSeconds: pass1Vcpu,
      gibSeconds: pass1Gib,
      diskGbSeconds: pass1Disk,
      classA: Math.ceil(corpusBytes * classAPerByte),
      classB: Math.ceil(corpusBytes * classBPerByte),
    },
    pass2: {
      wallSeconds: pass2Wall,
      vcpuSeconds: pass2Vcpu,
      gibSeconds: pass2Gib,
      diskGbSeconds: pass2Disk,
      inputBytes: spoolBytes,
      outputBytes,
      classA: Math.ceil((outputBytes / 1.5e6) * 1.2),
      classB: Math.ceil(outputBytes / 8e6) * 2,
    },
    storageGbMonths,
    grossUsd: computeUsd + diskUsd + r2RequestsUsd + storageUsd,
    billableUsd: computeUsd + diskUsd + r2RequestsUsd + storageUsd,
    breakdown: { computeUsd, r2RequestsUsd, storageUsd },
    notes,
  };
}
