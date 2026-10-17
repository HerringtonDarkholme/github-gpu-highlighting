import { MAX_SOURCE } from './limits';
import type { CachedResult } from './protocol';

const KEY = 'recentHighlights';
const MAX_ENTRIES = 4;
const MAX_CHARACTERS = 1_000_000;
let writes: Promise<void> = Promise.resolve();

// storage.session is extension-only browser memory, independent of the GPU
// host. It survives page reloads and service-worker suspension, not a restart.
async function load(): Promise<CachedResult[]> {
  const value = (await chrome.storage.session.get(KEY))[KEY];
  return Array.isArray(value) ? value.filter(entry => typeof entry?.source === 'string'
    && entry.source.length <= MAX_SOURCE && Array.isArray(entry.spans)).slice(0, MAX_ENTRIES) : [];
}

export async function readResults(): Promise<CachedResult[]> {
  await writes;
  try { return await load(); } catch { return []; }
}

export function rememberResult(entry: CachedResult): Promise<void> {
  writes = writes.then(async () => {
    const previous = await load();
    const entries = [entry, ...previous.filter(value => value.source !== entry.source)];
    const kept: CachedResult[] = [];
    let size = 0;
    for (const value of entries) {
      const length = JSON.stringify(value).length;
      if (size + length > MAX_CHARACTERS) continue;
      kept.push(value); size += length;
      if (kept.length === MAX_ENTRIES) break;
    }
    await chrome.storage.session.set({ [KEY]: kept });
  }).catch(() => { /* A cache quota or API failure must not block highlighting. */ });
  return writes;
}
