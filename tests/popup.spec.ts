import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

let popup: string;
const html = await readFile('public/popup.html', 'utf8');
const css = await readFile('public/popup.css', 'utf8');
test.beforeAll(async () => {
  popup = (await build({ entryPoints: ['src/popup.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120' })).outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 430 });
  await page.route('https://popup.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ body: path.endsWith('.css') ? css : path.endsWith('.js') ? popup : html,
      contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.addInitScript(() => {
    const state = { enabled: true, availability: 'Shared WebGPU runtime; warmed on GitHub visits',
      files: [{ id: 1, label: 'main/std/fmt.0', state: 'Highlighted', forced: false }] };
    const settings: Record<string, any> = {};
    const messages: string[] = [];
    Object.assign(window, { popupTest: { state, settings, messages } });
    Object.assign(globalThis, { chrome: {
      storage: { local: {
        get: async () => settings,
        set: async (value: Record<string, any>) => {
          Object.assign(settings, value);
          if ('enabled' in value) { state.enabled = value.enabled; for (const file of state.files) { file.forced = false; file.state = 'Highlighted'; } }
        },
      } },
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_id: number, message: { type: string }) => {
          messages.push(message.type);
          if (message.type === 'force' || message.type === 'unforce') {
            state.files[0].forced = message.type === 'force';
            state.files[0].state = message.type === 'force' ? 'Force highlighted' : 'Highlighted';
          }
          return structuredClone({ ...state, files: state.enabled ? state.files : [] });
        },
      },
    } });
  });
  await page.goto('https://popup.test/popup.html');
  await expect(page.locator('.badge')).toHaveAttribute('data-state', 'highlighted');
});

for (const theme of ['light', 'dark'] as const) test(`matches the supplied ${theme} design`, async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: theme });
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).length)).toBe(0);
  const reference = await context.newPage();
  await reference.setViewportSize({ width: 360, height: 430 });
  await reference.setContent(await readFile(`tests/fixtures/popup-reference-${theme}.html`, 'utf8'));
  const expected = await reference.screenshot({ path: `test-results/popup-reference-${theme}.png` });
  const actual = await page.screenshot({ path: `test-results/popup-${theme}.png` });
  // Compare rendered pixels in the same browser, avoiding platform-specific font snapshots.
  const difference = await reference.evaluate(async ({ expected, actual }) => {
    const decode = async (data: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 430;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, 360, 430).data;
    };
    const a = await decode(expected), b = await decode(actual);
    let different = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 8) different++;
    return different / (360 * 430);
  }, { expected: expected.toString('base64'), actual: actual.toString('base64') });
  expect(difference).toBeLessThan(0.005);
  await reference.close();
});

test('polling preserves cards and status changes crossfade with native CSS transitions', async ({ page }) => {
  await page.clock.install();
  const card = await page.locator('.file').elementHandle();
  await page.getByRole('button', { name: 'Force highlight' }).click();
  await expect(page.locator('.badge')).toHaveAttribute('data-state', 'forced');
  await expect(page.getByRole('button', { name: 'Stop forcing' })).toBeEnabled();
  expect(await page.evaluate(() => document.getAnimations().some(animation => animation instanceof CSSTransition))).toBe(true);
  await page.clock.runFor(1200);
  expect(await card!.evaluate(element => element === document.querySelector('.file'))).toBe(true);
  await page.getByRole('button', { name: 'Stop forcing' }).click();
  await expect(page.locator('.badge')).toHaveAttribute('data-state', 'highlighted');
  expect(await page.evaluate(() => (window as any).popupTest.messages)).toContain('unforce');
  await page.getByLabel('Enable automatic highlighting').uncheck();
  await expect(page.locator('.badge')).toHaveAttribute('data-state', 'off');
  await expect(page.locator('#enabled-label')).toHaveText('Off');
  await expect(page.locator('.btn')).toBeDisabled();
  await page.getByLabel('Enable automatic highlighting').check();
  await expect(page.locator('.badge')).toHaveAttribute('data-state', 'highlighted');
  expect(await card!.evaluate(element => element === document.querySelector('.file'))).toBe(true);
});

test('rainbow hover, keyboard focus, saved duration and reduced motion work', async ({ page }) => {
  await page.locator('.logo-border').hover();
  await expect.poll(() => page.locator('.logo-border').evaluate(element => getComputedStyle(element).animationName)).toBe('gh-spin');
  expect(await page.locator('.logo-border').evaluate(element => {
    const animation = element.getAnimations()[0]; animation.pause(); animation.currentTime = 0;
    const before = getComputedStyle(element).backgroundImage;
    animation.currentTime = 700;
    return before !== getComputedStyle(element).backgroundImage;
  })).toBe(true);
  await page.getByLabel('Color transition').fill('800'); await page.getByLabel('Color transition').blur();
  expect(await page.evaluate(() => (window as any).popupTest.settings.animation)).toEqual({ durationMs: 800 });
  await page.getByLabel('Enable automatic highlighting').focus();
  expect(await page.locator('.switch-border').evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.logo-border').hover();
  expect(await page.locator('.logo-border').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByLabel('Enable automatic highlighting').uncheck();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('pending, native, skipped and GPU errors remain visible without horizontal overflow', async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => {
    (window as any).popupTest.state.files = ['Pending', 'GitHub highlighting', 'Skipped: size limit', 'Unavailable'].map((state, id) => ({ id, label: 'a/very/long/path/'.repeat(10), state, forced: false }));
    (window as any).popupTest.state.availability = 'WebGPU unavailable or model initialization failed';
  });
  await page.clock.runFor(1100);
  await expect(page.locator('.file')).toHaveCount(4);
  await expect(page.locator('#availability')).toHaveText('Highlighting unavailable');
  expect(await page.locator('.badge').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.state))).toEqual(['pending', 'native', 'skipped', 'unavailable']);
  expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBe(360);
  expect(await page.locator('main').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
});
