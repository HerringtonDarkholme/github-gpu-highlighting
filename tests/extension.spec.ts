import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const fixture = await readFile(new URL('./fixtures/surfaces.html', import.meta.url), 'utf8');
test.describe('packaged MV3 extension', () => {
  let context: BrowserContext, page: Page, popup: Page, profile: string;
  let external: string[];

  test.beforeEach(async () => {
    profile = await mkdtemp(join(tmpdir(), 'github-gpu-test-'));
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH,
      channel: process.env.CHROME_PATH ? undefined : 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    page = context.pages()[0];
    external = [];
    context.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith('https://github.com/')) external.push(request.url());
    });
    await context.route('https://github.com/**', route => route.fulfill({
      body: fixture,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'" },
    }));
  });
  test.afterEach(async () => {
    await context?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  async function openPopup(): Promise<void> {
    const cdp = await context.newCDPSession(page);
    let id = '';
    cdp.on('Runtime.executionContextCreated', event => {
      if (event.context.name === 'Universal GitHub Highlighting') id = event.context.origin.replace('chrome-extension://', '');
    });
    await cdp.send('Runtime.enable');
    await expect.poll(() => id).not.toBe('');
    popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
  }

  async function background() {
    return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  }

  async function offscreenContexts() {
    return (await background()).evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }));
  }

  test('real offline model, isolated world, restrictive GitHub CSP, themes, popup force and toggle', async () => {
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    const adapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
    test.skip(!adapter && !process.env.EXPECT_WEBGPU, 'No GPU adapter; deterministic failure tests still run');
    expect(adapter, 'EXPECT_WEBGPU requires an available GPU adapter').toBe(true);
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    const nativeBefore = await page.locator('.markdown-body .highlight').innerHTML();
    const codeBefore = await page.locator('.react-code-lines').innerHTML();
    const diffBefore = await page.locator('.diff-table').innerHTML();
    await openPopup();
    await expect(popup.locator('.file small')).toHaveText(['Highlighted', 'Highlighted', 'Highlighted', 'GitHub highlighting']);
    expect(await page.locator('.markdown-body .highlight').innerHTML()).toBe(nativeBefore);
    await page.screenshot({ path: 'test-results/extension-light.png' });
    const light = await page.locator('#LC1').evaluate(e => getComputedStyle(e, '::highlight(ugh-keyword)').color);
    await page.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
    await page.screenshot({ path: 'test-results/extension-dark.png' });
    const dark = await page.locator('#LC1').evaluate(e => getComputedStyle(e, '::highlight(ugh-keyword)').color);
    expect(dark).not.toBe(light);
    await popup.locator('.file').last().getByRole('button').click();
    await expect(popup.locator('.file small').last()).toHaveText('Force highlighted');
    await popup.getByLabel('Enable automatic highlighting').uncheck();
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
    await expect.poll(async () => (await offscreenContexts()).length).toBe(0);
    expect(await page.locator('.react-code-lines').innerHTML()).toBe(codeBefore);
    expect(await page.locator('.diff-table').innerHTML()).toBe(diffBefore);
    await popup.getByLabel('Enable automatic highlighting').check();
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(1);
    expect(external).toEqual([]);
  });

  test('content scripts do not need WebGPU; inference runs in the shared worker', async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Runtime.enable');
    let disabled = false;
    cdp.on('Runtime.executionContextCreated', async event => {
      if (event.context.name === 'Universal GitHub Highlighting') {
        await cdp.send('Runtime.evaluate', { contextId: event.context.id, expression: 'delete Navigator.prototype.gpu' });
        disabled = true;
      }
    });
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(() => disabled).toBe(true);
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    expect(await page.locator('#LC1').textContent()).toBe('invent greet(name) => "hello 😀"');
  });

  test('one lazy runtime survives page reloads and tabs, expires after the last GitHub tab leaves, and recreates on return', async () => {
    const bg = await background();
    expect(await offscreenContexts()).toHaveLength(0);
    await page.route('https://github.com/warmup', route => route.fulfill({ body: '<!doctype html><main>Repository home</main>', contentType: 'text/html' }));
    await page.goto('https://github.com/warmup');
    await expect.poll(async () => (await offscreenContexts()).length).toBe(1);
    const original = (await offscreenContexts())[0].documentId;
    const warmed = await bg.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'warm' }));
    expect(warmed.error).toBeUndefined();
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    await page.reload();
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(1);
    const second = await context.newPage();
    await second.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(() => second.evaluate(() => CSS.highlights.size)).toBeGreaterThan(1);
    expect((await offscreenContexts())[0].documentId).toBe(original);
    await page.close();
    expect(await bg.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeUndefined();
    await second.goto('about:blank');
    await expect.poll(() => bg.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeTruthy();
    const idle = await bg.evaluate(() => chrome.alarms.get('gpu-lexer-idle'));
    expect(idle!.scheduledTime - Date.now()).toBeGreaterThan(170_000);
    expect(idle!.scheduledTime - Date.now()).toBeLessThanOrEqual(180_000);
    expect((await offscreenContexts())[0].documentId).toBe(original);
    await second.goto('https://github.com/test/repo/blob/main/other.invented');
    await expect.poll(() => bg.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeUndefined();
    expect((await offscreenContexts())[0].documentId).toBe(original);
    await second.goto('about:blank');
    await expect.poll(() => bg.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeTruthy();
    // Exercise the real Chrome alarm callback without spending three minutes in
    // each run; the scheduled production delay was checked immediately above.
    await bg.evaluate(() => chrome.alarms.create('gpu-lexer-idle', { when: Date.now() - 1 }));
    await expect.poll(async () => (await offscreenContexts()).length).toBe(0);
    await second.goto('https://github.com/test/repo/blob/main/other.invented');
    await expect.poll(async () => (await offscreenContexts()).length).toBe(1);
    expect((await offscreenContexts())[0].documentId).not.toBe(original);
    await expect.poll(() => second.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
  });

  test('worker GPU failure leaves original rendering intact and reports unavailability', async () => {
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH,
      channel: process.env.CHROME_PATH ? undefined : 'chromium', headless: true,
      args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--disable-gpu', '--disable-software-rasterizer'],
    });
    page = context.pages()[0];
    await page.route('https://github.com/**', route => route.fulfill({ body: fixture, contentType: 'text/html; charset=utf-8' }));
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await openPopup();
    await expect(popup.locator('#availability')).toContainText('unavailable', { timeout: 25_000 });
    expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
    expect(await page.locator('#LC1').textContent()).toBe('invent greet(name) => "hello 😀"');
  });

  test('stopping and waking the service worker preserves the offscreen GPU host', async () => {
    const cdp = await context.newCDPSession(page);
    let version = '', stopped = false;
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const worker of event.versions) {
        if (worker.scriptURL.endsWith('/background.js')) {
          version = worker.versionId;
          if (worker.runningStatus === 'stopped') stopped = true;
        }
      }
    });
    await cdp.send('ServiceWorker.enable');
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    await openPopup();
    const before = await popup.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }));
    await expect.poll(() => version).not.toBe('');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version });
    await expect.poll(() => stopped).toBe(true);
    await page.reload();
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(1);
    const after = await popup.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }));
    expect(after[0].documentId).toBe(before[0].documentId);
  });

  test('an idle alarm waking a suspended service worker closes the host without restarting the grace period', async () => {
    const cdp = await context.newCDPSession(page);
    let version = '', stopped = false;
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const worker of event.versions) {
        if (worker.scriptURL.endsWith('/background.js')) {
          version = worker.versionId;
          if (worker.runningStatus === 'stopped') stopped = true;
        }
      }
    });
    await cdp.send('ServiceWorker.enable');
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(async () => (await offscreenContexts()).length).toBe(1);
    await openPopup();
    await page.goto('about:blank');
    await expect.poll(() => popup.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeTruthy();
    await popup.evaluate(() => chrome.alarms.create('gpu-lexer-idle', { when: Date.now() + 1000 }));
    await expect.poll(() => version).not.toBe('');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version });
    await expect.poll(() => stopped).toBe(true);
    await expect.poll(() => popup.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length), { timeout: 10_000 }).toBe(0);
    expect(await popup.evaluate(() => chrome.alarms.get('gpu-lexer-idle'))).toBeUndefined();
  });
});
