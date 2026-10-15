/**
 * Small re-export surface: components import presentation helpers and the API
 * mode from here, which keeps their import lists short and avoids importing the
 * API client (and its caches) from purely visual modules.
 */

export {
  formatBytes,
  formatCompact,
  formatDate,
  formatDay,
  formatNumber,
  formatPercent,
  leadStatusLabel,
  matchCategoryLabel,
  relativeTime,
  truncate,
} from "./format";

export { apiMode, apiBaseUrl } from "./api/client";
