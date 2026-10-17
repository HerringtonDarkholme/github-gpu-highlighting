// Capture the real extension in an isolated browser; never uses an existing profile.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const output = resolve('store-assets');
await mkdir(join(output, 'screenshots'), { recursive: true });
await mkdir(join(output, 'source'), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'github-gpu-store-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : 'chromium', headless: true,
  viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const examples = [
    { url: 'https://github.com/HerringtonDarkholme/hd-lang/blob/main/lib/std/json.hd', themes: ['dark', 'light'], name: 'json-hd' },
    { url: 'https://github.com/vercel-labs/zerolang/blob/main/std/json.0', themes: ['dark'], name: 'json-zerolang' },
    { url: 'https://github.com/mizchi/vibe-lang/blob/main/lib/%40vibe/json/json_types.vibe', themes: ['light'], name: 'json-types-vibe' },
  ];
  const captures = [];
  let number = 0;
  for (const { url, themes, name } of examples) {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: themes[0] });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.react-file-line').first().waitFor();
    const source = await page.locator('textarea#read-only-cursor-text-area').inputValue().catch(() => '');
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('.react-code-lines');
      return [...CSS.highlights].some(([type, ranges]) => type !== 'ugh-plain'
        && [...ranges].some(range => root?.contains(range.startContainer)));
    }), { timeout: 45_000 }).toBe(true);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('.file small').first()).toHaveText('Highlighted');
    const actualStatus = await popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'status' });
    });
    for (const theme of themes) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(theme => {
        document.documentElement.setAttribute('data-color-mode', theme);
        document.documentElement.setAttribute('data-dark-theme', 'dark');
        document.documentElement.setAttribute('data-light-theme', 'light');
        // Keep repository and file context while giving the source more room.
        window.scrollTo(0, 72);
      }, theme);
      await expect(page.locator('[data-ugh-fade]')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      // Allow GitHub's sticky header and content-visibility regions to repaint.
      await page.waitForTimeout(600);
      const filename = `${String(++number).padStart(2, '0')}-${name}-${theme}.png`;
      await page.screenshot({ path: join(output, 'screenshots', filename) });
      console.log(`Captured ${filename}`);
    }
    if (source) expect(await page.locator('textarea#read-only-cursor-text-area').inputValue()).toBe(source);
    captures.push({ url, version: '1.0.0', sourcePreserved: Boolean(source), status: actualStatus.files, themes });
    // Preserve an actual rendered popup for the listing's controls screenshot.
    if (number === 2) {
      await popup.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => popup.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).length)).toBe(0);
      await popup.screenshot({ path: join(output, 'source', 'popup-capture.png'), clip: { x: 0, y: 0, width: 360, height: 430 } });
    }
    await popup.close();
    await page.close();
  }
  await writeFile(join(output, 'source', 'capture-info.json'), JSON.stringify({ captures, screenshotSize: [1280, 800] }, null, 2) + '\n');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
