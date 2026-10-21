/**
 * Coverage state for the REAL DATA panels.
 *
 * Kept in its own module so the provider/router tree and the existing `ApiClient`
 * contract stay untouched. A deployment without the real-data routes (the local
 * preview) simply gets `null` and the panels hide themselves.
 */

import { useQuery } from "@tanstack/react-query";
import { getRealDataCoverage } from "@/lib/api/realdata";
import type { RealDataCoverageResponse } from "@/shared/realdata/types";

export const realDataQueryKeys = {
  coverage: ["realdata", "coverage"] as const,
};

export function useRealDataCoverage() {
  return useQuery<RealDataCoverageResponse | null>({
    queryKey: realDataQueryKeys.coverage,
    queryFn: async () => {
      try {
        return await getRealDataCoverage();
      } catch {
        // No real-data route on this deployment (or a transient error): the UI
        // treats that as "not available" and never fabricates coverage.
        return null;
      }
    },
    staleTime: 60_000,
    retry: 0,
  });
}
