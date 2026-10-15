/**
 * Locally remembered "recently viewed companies".
 *
 * Deliberately browser-local and tiny: it is a convenience list, not application
 * state, and writing it must never cost an R2 operation. Reads/writes are
 * bounded to 12 entries.
 */

export interface RecentCompany {
  id: string;
  name: string;
  at: string;
}

const KEY = "companyintel.recent-companies";
const MAX = 12;

export function readRecentCompanies(): RecentCompany[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentCompany[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberCompany(company: { id: string; name: string }): void {
  try {
    const rest = readRecentCompanies().filter((entry) => entry.id !== company.id);
    const next = [{ id: company.id, name: company.name, at: new Date().toISOString() }, ...rest].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: recent history is optional.
  }
}
