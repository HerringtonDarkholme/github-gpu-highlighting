import type { CachedResult } from './protocol';

const KEY = 'ugh-reload';
const MAX_CHARACTERS = 600_000;

// A one-use handoff from a live page to its immediate reload. Other navigations,
// sleeping tabs and restored browser sessions still wait for current settings.
export function takeReloadCache(): CachedResult[] | undefined {
  try {
    const text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!text || text.length > MAX_CHARACTERS
      || (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type !== 'reload') return;
    const value = JSON.parse(text);
    const age = Date.now() - value.at;
    if (value.url !== location.href || !Number.isFinite(age) || age < 0 || age > 5000 || !Array.isArray(value.cache)) return;
    return value.cache.slice(0, 4);
  } catch { return; }
}

export function saveReloadCache(enabled: boolean, cache: CachedResult[]): void {
  try {
    sessionStorage.removeItem(KEY);
    if (!enabled) return;
    const kept: CachedResult[] = [];
    for (const entry of cache.slice().reverse()) {
      if (JSON.stringify({ url: location.href, at: Date.now(), cache: [...kept, entry] }).length > MAX_CHARACTERS) continue;
      kept.push(entry);
      if (kept.length === 4) break;
    }
    if (kept.length) sessionStorage.setItem(KEY, JSON.stringify({ url: location.href, at: Date.now(), cache: kept }));
  } catch { /* Disabled page storage or quota exhaustion falls back to bootstrap. */ }
}
