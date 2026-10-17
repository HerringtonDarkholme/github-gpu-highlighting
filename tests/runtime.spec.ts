import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

let harness: string;
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/runtime-harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120' })).outputFiles[0].text;
});
test.beforeEach(async ({ page }) => { await page.addScriptTag({ content: harness }); });

test('runtime is lazy, created once across tabs, and not kept alive by unrelated tabs', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = (window as any).makeHost();
    await h.sync(); const initial = h.state();
    h.setTabs([{ id: 1, url: 'https://github.com/test/a' }, { id: 2, url: 'https://github.com/test/b' }]);
    await Promise.all([h.sync(), h.sync(), h.parse('source')]); const active = h.state();
    h.setTabs([{ id: 3, url: 'https://example.com' }]); await h.sync();
    return { initial, active, idle: h.state() };
  });
  expect(result.initial).toMatchObject({ creates: 0, exists: false });
  expect(result.active).toMatchObject({ creates: 1, closes: 0, exists: true, alarm: undefined });
  expect(result.idle).toMatchObject({ creates: 1, closes: 0, alarm: { scheduledTime: 180_000 } });
});

test('three-minute deadline survives service-worker restarts and unrelated tab events', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = (window as any).makeHost();
    h.setTabs([{ id: 1, url: 'https://github.com/test/a' }]); await h.sync();
    h.setTabs([]); await h.sync(); const alarm = h.state().alarm;
    h.advance(120_000); h.restartServiceWorker(); await h.sync();
    const restarted = h.state();
    await h.idle(alarm); const early = h.state();
    h.advance(60_000); await h.idle(alarm);
    return { restarted, early, expired: h.state() };
  });
  expect(result.restarted).toMatchObject({ creates: 1, alarm: { scheduledTime: 180_000 } });
  expect(result.early).toMatchObject({ exists: true, closes: 0 });
  expect(result.expired).toMatchObject({ exists: false, closes: 1, alarm: undefined });
});

test('reopening GitHub cancels cleanup; an old queued alarm cannot shorten the next idle period', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = (window as any).makeHost();
    h.setTabs([{ id: 1, url: 'https://github.com/test/a' }]); await h.sync();
    h.setTabs([]); await h.sync(); const old = h.state().alarm;
    h.advance(100_000); h.setTabs([{ id: 2, url: 'https://github.com/test/b' }]); await h.sync();
    await h.idle(old); const reopened = h.state();
    h.setTabs([]); await h.sync(); h.advance(90_000); await h.idle(old);
    return { reopened, later: h.state() };
  });
  expect(result.reopened).toMatchObject({ creates: 1, closes: 0, alarm: undefined });
  expect(result.later).toMatchObject({ exists: true, closes: 0, alarm: { scheduledTime: 280_000 } });
});

test('disabling releases the worker immediately; closed tabs cannot recreate it with stale requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = (window as any).makeHost();
    h.setTabs([{ id: 1, url: 'https://github.com/test/a' }]); await h.sync();
    h.setEnabled(false); await h.sync(); const disabled = h.state();
    const denied = await h.parse('source');
    h.setTabs([]); h.setEnabled(true); const stale = await h.parse('source');
    await h.sync();
    return { disabled, denied, stale, final: h.state() };
  });
  expect(result.disabled).toMatchObject({ exists: false, closes: 1 });
  expect(result.denied.error).toBeTruthy(); expect(result.stale.error).toBeTruthy();
  expect(result.final).toMatchObject({ creates: 1, exists: false });
});

test('pending GitHub navigation warms the host before the document finishes loading', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = (window as any).makeHost();
    h.setTabs([{ id: 1, url: 'about:blank', pendingUrl: 'https://github.com/test/a' }]);
    await h.sync(); return h.state();
  });
  expect(result).toMatchObject({ creates: 1, exists: true, alarm: undefined });
});
