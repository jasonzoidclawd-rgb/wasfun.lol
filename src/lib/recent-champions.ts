/** The last champions a visitor opened (Home chips). Browser-only, best effort. */
export const RECENT_CHAMPIONS_KEY = "wasfun:recent-champions";
const MAX = 3;

export function readRecentChampions(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_CHAMPIONS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberChampion(slug: string): void {
  try {
    const next = [slug, ...readRecentChampions().filter((s) => s !== slug)].slice(0, MAX);
    localStorage.setItem(RECENT_CHAMPIONS_KEY, JSON.stringify(next));
  } catch {
    // private mode: nothing to remember
  }
}
