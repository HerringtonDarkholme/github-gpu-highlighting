// Real before/after captures in a temporary browser profile; no source DOM edits.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = resolve('assets/screenshots');
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'github-gpu-readme-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : 'chromium',
  headless: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2,
  colorScheme: 'dark',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
  const page = await context.newPage();
  const url = 'https://github.com/HerringtonDarkholme/hd-lang/blob/main/lib/std/json.hd';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('.react-file-line');
  await rows.first().waitFor();
  const source = await page.locator('textarea#read-only-cursor-text-area').inputValue();
  expect(source).not.toBe('');
  expect(await page.locator('.react-code-lines [class^="pl-"]').count()).toBe(0);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    document.documentElement.setAttribute('data-dark-theme', 'dark');
  });
  // Frame the Json enum and object structure rather than introductory comments.
  await rows.nth(13).evaluate(row => window.scrollTo(0, row.getBoundingClientRect().top + scrollY - 170));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const clip = await rows.nth(13).evaluate(row => {
    const bounds = row.getBoundingClientRect();
    const x = Math.max(0, bounds.left - 60);
    return { x, y: bounds.top, width: Math.min(900, innerWidth - x - 16), height: 480 };
  });
  const colored = () => page.evaluate(() => {
    const root = document.querySelector('.react-code-lines');
    return [...CSS.highlights].some(([type, ranges]) => type !== 'ugh-plain'
      && [...ranges].some(range => root?.contains(range.startContainer)));
  });
  expect(await colored()).toBe(false);
  await page.screenshot({ path: join(directory, 'json-hd-before.png'), clip });
  await worker.evaluate(() => chrome.storage.local.set({ enabled: true }));
  await expect.poll(colored, { timeout: 45_000 }).toBe(true);
  await expect(page.locator('[data-ugh-fade]')).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(await page.locator('textarea#read-only-cursor-text-area').inputValue()).toBe(source);
  await page.screenshot({ path: join(directory, 'json-hd-after.png'), clip });
  await writeFile(join(directory, 'capture-info.json'), JSON.stringify({
    url, sourcePreserved: true, automaticHighlighting: true, theme: 'dark', clip,
    deviceScaleFactor: 2, note: 'Same page, crop, and source; only the extension toggle changed.',
  }, null, 2) + '\n');
  console.log('Captured real before/after screenshots; source preserved.');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
