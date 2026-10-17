import { test, expect } from '@playwright/test';
import { readResults, rememberResult } from '../src/result-cache';
import type { CachedResult } from '../src/protocol';

test('recent-result memory stays bounded, deduplicates source and tolerates storage failures', async () => {
  const previous = (globalThis as any).chrome;
  let stored: Record<string, unknown> = {}, fail = false;
  (globalThis as any).chrome = { storage: { session: {
    get: async () => stored,
    set: async (value: Record<string, unknown>) => { if (fail) throw new Error('quota'); stored = value; },
  } } };
  const result = (source: string): CachedResult => ({ source, spans: [{ type: 'keyword', start: 0, end: source.length }] });
  try {
    for (const source of ['a', 'b', 'c', 'd', 'e']) await rememberResult(result(source));
    expect((await readResults()).map(entry => entry.source)).toEqual(['e', 'd', 'c', 'b']);
    await rememberResult(result('d'));
    expect((await readResults()).map(entry => entry.source)).toEqual(['d', 'e', 'c', 'b']);
    await rememberResult({ source: 'x'.repeat(120_000), spans: Array.from({ length: 24_000 }, (_, i) => ({ type: 'keyword', start: i * 5, end: i * 5 + 5 })) });
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(1_000_100);
    expect((await readResults()).map(entry => entry.source)).toEqual(['d', 'e', 'c', 'b']);
    fail = true;
    await rememberResult(result('failure'));
    expect((await readResults()).map(entry => entry.source)).toEqual(['d', 'e', 'c', 'b']);
  } finally { (globalThis as any).chrome = previous; }
});
