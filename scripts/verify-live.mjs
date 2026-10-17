// Optional online smoke test. Extension runtime itself makes no network requests.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'github-gpu-live-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : 'chromium',
  headless: true,
  viewport: { width: 1440, height: 1050 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results = [];
await mkdir('test-results', { recursive: true });
try {
  const page = context.pages()[0];
  let extensionId = '';
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === 'Universal GitHub Highlighting') extensionId = context.origin.replace('chrome-extension://', '');
  });
  await cdp.send('Runtime.enable');
  const painted = () => page.evaluate(() => [...CSS.highlights].map(([type, ranges]) => ({ type, ranges: ranges.size })));
  const wait = async predicate => {
    const end = Date.now() + 25_000;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error('Timed out waiting for live highlighting');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  const unknown = process.env.UNKNOWN_URL ?? 'https://github.com/HerringtonDarkholme/hd-lang/blob/main/lib/std/ops.hd';
  await page.goto(unknown);
  await page.locator('.react-file-line').first().waitFor();
  const originalText = await page.locator('.react-code-lines').textContent();
  const nativeTokens = await page.locator('.react-code-lines [class^="pl-"]').count();
  assert.equal(nativeTokens, 0, 'Choose a source file GitHub does not already highlight');
  await wait(async () => (await painted()).length > 1);
  assert.equal(await page.locator('.react-code-lines').textContent(), originalText);
  // GitHub renders code below the fold too. Those ranges must already be
  // installed, without requiring another inference when they become visible.
  const scrollLines = await page.locator('.react-file-line').evaluateAll(rows => {
    const nonempty = rows.filter(row => row.textContent.trim());
    return [nonempty[Math.floor(nonempty.length / 2)].id, nonempty.at(-1).id, nonempty[0].id];
  });
  for (const id of scrollLines) {
    const line = page.locator(`[id="${id}"]`);
    await line.scrollIntoViewIfNeeded();
    await wait(() => line.evaluate(element => [...CSS.highlights].some(([, ranges]) =>
      [...ranges].some(range => element.contains(range.startContainer) && range.startContainer.textContent.slice(range.startOffset, range.endOffset).trim()))));
    // Let GitHub reveal any content-visibility sections before the next scroll
    // or screenshot; range membership alone doesn't mean it has painted yet.
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: 'test-results/live-unknown-light.png' });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    document.documentElement.setAttribute('data-dark-theme', 'dark');
  });
  await page.screenshot({ path: 'test-results/live-unknown-dark.png' });
  results.push({ surface: 'unknown source', url: page.url(), nativeTokens, textPreserved: true, scrollLines, highlights: await painted() });

  // This click uses GitHub's React router rather than page.goto/reloading.
  const nextPath = '/HerringtonDarkholme/hd-lang/blob/main/lib/std/sys.hd';
  if (unknown.includes('/HerringtonDarkholme/hd-lang/')) {
    const link = page.getByRole('treeitem', { name: 'sys.hd', exact: true });
    await link.waitFor();
    await page.evaluate(() => { window.__liveDocument = true; });
    await link.click();
    await page.waitForURL(`**${nextPath}`);
    await wait(async () => (await painted()).length > 1);
    assert.equal(await page.evaluate(() => window.__liveDocument), true, 'Navigation unexpectedly reloaded');
    results.push({ surface: 'client navigation', url: page.url(), documentRetained: true, highlights: await painted() });
  }

  if (unknown.includes('/vercel-labs/zerolang/')) {
    await page.evaluate(() => { window.__liveDocument = true; });
    for (const file of ['regex.0', 'cli.0']) {
      await page.getByRole('treeitem', { name: file, exact: true }).click();
      await page.waitForURL(`**/std/${file}`);
      await wait(() => page.evaluate(() => {
        const root = document.querySelector('.react-code-lines');
        return [...CSS.highlights].some(([type, ranges]) => type !== 'ugh-plain'
          && [...ranges].some(range => root?.contains(range.startContainer) && range.startContainer.textContent.slice(range.startOffset, range.endOffset).trim()));
      }));
      assert.equal(await page.evaluate(() => window.__liveDocument), true, 'Navigation unexpectedly reloaded');
      results.push({ surface: 'zerolang client navigation', url: page.url(), documentRetained: true, highlights: await painted() });
    }
  }

  await page.goto('https://github.com/vercel-labs/gpu-lexer/blob/main/packages/core/src/index.js');
  await page.locator('.react-code-lines .pl-k').first().waitFor();
  await page.waitForTimeout(1200);
  assert.equal((await painted()).length, 0, 'Must respect GitHub syntax');
  results.push({ surface: 'recognized JavaScript', url: page.url(), nativePreserved: true });

  await page.goto('https://github.com/vercel-labs/gpu-lexer/pull/2/files');
  const diff = page.locator('.diff-table').first();
  await diff.waitFor();
  await page.waitForTimeout(1500);
  const original = await diff.innerHTML();
  const backgrounds = await diff.locator('.blob-code-addition, .blob-code-deletion').evaluateAll(es => es.map(e => getComputedStyle(e).backgroundColor));
  const popup = await context.newPage();
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('.file').first().waitFor();
  // Exercise force even if GitHub has already supplied native tokens to a hunk.
  await popup.locator('.file').first().getByRole('button').click();
  await wait(async () => (await popup.locator('.file small').first().textContent()) === 'Force highlighted');
  assert.equal(await diff.innerHTML(), original, 'Source DOM changed during highlighting');
  assert.deepEqual(await diff.locator('.blob-code-addition, .blob-code-deletion').evaluateAll(es => es.map(e => getComputedStyle(e).backgroundColor)), backgrounds);
  await page.screenshot({ path: 'test-results/live-pr-diff.png' });
  results.push({ surface: 'live PR diff', url: page.url(), markupPreserved: true, backgroundsPreserved: true, highlights: await painted() });
  await writeFile('test-results/live-report.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
