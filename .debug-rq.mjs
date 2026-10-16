import { QueryClient } from "@tanstack/react-query";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
const key = ["dataset", "status"];
try {
  await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error("Network unreachable")) });
} catch {
  // expected
}
const state = client.getQueryState(key);
console.log("status:", state?.status, "| fetchStatus:", state?.fetchStatus, "| error:", state?.error?.message);
