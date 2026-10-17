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

  test('the packaged extension paints a gradual fade under restrictive CSP', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Pause the real content-script animations at their first paint so pixel
    // comparisons do not depend on GPU startup speed or machine scheduling.
    const pauseNextReveal = () => {
      const pauseReveal = () => {
        const animations = document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal');
        if (!animations.length) { requestAnimationFrame(pauseReveal); return; }
        for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
      };
      requestAnimationFrame(pauseReveal);
    };
    await page.addInitScript(pauseNextReveal);
    await page.goto('https://github.com/test/repo/blob/main/fade.invented');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal' && a.playState === 'paused').length), { timeout: 25_000 }).toBeGreaterThan(0);
    const before = await page.locator('.react-code-lines').innerHTML();
    const clip = (await page.locator('#LC1').boundingBox())!;
    const pixels = [];
    const progress = [];
    for (const time of [0, 100, 210, 420]) {
      progress.push(await page.evaluate(time => {
        for (const animation of document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal')) animation.currentTime = time;
        return Number(getComputedStyle(document.querySelector('#LC1')!).getPropertyValue('--ugh-reveal'));
      }, time));
      pixels.push(await page.screenshot({ clip, path: `test-results/fade-${time}.png` }));
    }
    expect(progress[0]).toBe(0);
    expect(progress[1]).toBeGreaterThan(0);
    expect(progress[1]).toBeCloseTo(100 / 420, 2);
    expect(progress[2]).toBeCloseTo(0.5, 1);
    expect(progress[3]).toBe(1);
    expect(pixels[0].equals(pixels[1])).toBe(false);
    expect(pixels[1].equals(pixels[2])).toBe(false);
    expect(pixels[2].equals(pixels[3])).toBe(false);
    expect(await page.locator('.react-code-lines').innerHTML()).toBe(before);
    await page.evaluate(() => {
      for (const animation of document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal')) animation.finish();
    });
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal').length)).toBe(0);
    const highlighted = await page.screenshot({ clip });
    // GitHub replaces its server-rendered root during hydration. Identical
    // source must retain its completed colors instead of starting a second fade.
    await page.locator('.react-code-lines').evaluate(root => root.replaceWith(root.cloneNode(true)));
    await expect.poll(() => page.evaluate(() => [...CSS.highlights.get('ugh-keyword')!].every(range => range.startContainer.isConnected))).toBe(true);
    expect(await page.screenshot({ clip })).toEqual(highlighted);
    expect(await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal').length)).toBe(0);
    // The popup's off/on path uses completed page cache, which must still fade
    // when restoring colors over plain text that the user has already seen.
    await openPopup();
    await page.evaluate(pauseNextReveal);
    await popup.getByLabel('Enable automatic highlighting').uncheck();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal' && a.playState === 'paused').length)).toBeGreaterThan(0);
    const fadingOut = [];
    for (const time of [0, 210, 420]) {
      await page.evaluate(time => {
        for (const animation of document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal')) animation.currentTime = time;
      }, time);
      fadingOut.push(await page.screenshot({ clip, path: `test-results/fade-out-${time}.png` }));
    }
    expect(fadingOut[0]).toEqual(highlighted);
    expect(fadingOut[0].equals(fadingOut[1])).toBe(false);
    expect(fadingOut[1].equals(fadingOut[2])).toBe(false);
    expect(fadingOut[2]).toEqual(pixels[0]);
    await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
    await page.evaluate(pauseNextReveal);
    await popup.getByLabel('Enable automatic highlighting').check();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal' && a.playState === 'paused').length)).toBeGreaterThan(0);
    const restored = [];
    for (const time of [0, 210, 420]) {
      await page.evaluate(time => {
        for (const animation of document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty === '--ugh-reveal')) animation.currentTime = time;
      }, time);
      restored.push(await page.screenshot({ clip, path: `test-results/fade-cached-${time}.png` }));
    }
    expect(restored[0].equals(restored[1])).toBe(false);
    expect(restored[1].equals(restored[2])).toBe(false);
    expect(await page.locator('.react-code-lines').innerHTML()).toBe(before);
  });

  test('reload restores cached colors before any plain-code compositor frame', async () => {
    await page.route('https://github.com/test/repo/blob/main/reload.invented', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'" },
      body: '<!doctype html><style>:root{--color-prettylights-syntax-keyword:#cf222e;color:#1f2328}.react-file-line{white-space:pre;font:14px/24px monospace}</style><main><div class="react-code-lines"><div id="LC1" class="react-file-line">return value</div><div class="react-file-line">return 42</div></div></main>',
    }));
    await page.goto('https://github.com/test/repo/blob/main/reload.invented');
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const box = await page.locator('#LC1').evaluate(element => {
      const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 6);
      return range.getBoundingClientRect().toJSON();
    });
    const bg = await background();
    await bg.evaluate(() => {
      const runtime = chrome.runtime as any, send = runtime.sendMessage.bind(runtime);
      (globalThis as any).parseCalls = 0;
      runtime.sendMessage = (message: any, ...args: any[]) => {
        if (message?.target === 'offscreen' && message.type === 'parse') (globalThis as any).parseCalls++;
        return send(message, ...args);
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    const frames: { data: string; time: number }[] = [];
    cdp.on('Page.screencastFrame', event => {
      frames.push({ data: event.data, time: event.metadata.timestamp! });
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    for (let i = 0; i < 2; i++) {
      await page.reload();
      await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(1);
      await page.waitForTimeout(100);
    }
    await cdp.send('Page.stopScreencast');
    expect(await bg.evaluate(() => (globalThis as any).parseCalls)).toBe(0);
    // Decode actual compositor frames after recording, without sampling styles
    // or pausing animations while the reload is taking place.
    const decoder = await context.newPage();
    const samples = await decoder.evaluate(async ({ frames, box }) => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      const samples = [];
      for (const frame of frames) {
        const image = new Image(); image.src = `data:image/png;base64,${frame.data}`;
        await image.decode(); canvas.width = image.width; canvas.height = image.height; ctx.drawImage(image, 0, 0);
        const x = Math.floor(box.x), y = Math.floor(box.y);
        const pixels = ctx.getImageData(x, y, Math.ceil(box.right) - x, Math.ceil(box.bottom) - y).data;
        let ink = 0, red = -255;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) {
            ink++; red = Math.max(red, pixels[i] - pixels[i + 1]);
          }
        }
        samples.push({ ink, red });
      }
      return samples;
    }, { frames, box });
    expect(samples.filter(sample => sample.ink > 10).length).toBeGreaterThan(0);
    expect(samples.filter(sample => sample.ink > 10 && sample.red < 150)).toEqual([]);
    expect(external).toEqual([]);
  });

  test('disabled highlighting stays disabled when a previously cached file reloads', async () => {
    await page.goto('https://github.com/test/repo/blob/main/example.invented');
    await expect.poll(() => page.evaluate(() => CSS.highlights.size), { timeout: 25_000 }).toBeGreaterThan(1);
    await openPopup();
    await popup.getByLabel('Enable automatic highlighting').uncheck();
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
    await page.reload();
    await expect(popup.getByLabel('Enable automatic highlighting')).not.toBeChecked();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('ugh-reload'))).toBeNull();
  });

  test('large files stay highlighted from top to bottom when scrolling', async () => {
    await page.goto('https://github.com/test/repo/blob/main/large.invented');
    const before = await page.evaluate(() => {
      document.querySelector('.file')!.remove();
      document.querySelector('.markdown-body')!.remove();
      const root = document.querySelector('.react-code-lines')!;
      const rows = Array.from({ length: 1800 }, (_, i) => {
        const row = document.createElement('div');
        row.className = 'react-file-line'; row.id = `LC${i + 1}`;
        row.textContent = `let item_${i}: Int = 42 // a long source file remains highlighted`;
        return row;
      });
      root.replaceChildren(...rows);
      return root.innerHTML;
    });
    const covered = () => page.evaluate(() => {
      const rows = [...document.querySelectorAll('.react-file-line')];
      const ranges = [...CSS.highlights].flatMap(([, highlight]) => [...highlight]);
      const nodes = new Set(ranges.map(range => range.startContainer));
      return rows.filter(row => row.firstChild && nodes.has(row.firstChild)).length;
    });
    await expect.poll(covered, { timeout: 25_000 }).toBe(1800);
    await expect.poll(() => page.locator('[data-ugh-fade]').count()).toBe(0);
    const sizes = await page.evaluate(() => [...CSS.highlights].map(([type, ranges]) => [type, ranges.size]));
    const cdp = await context.newCDPSession(page);
    const frames: string[] = [];
    cdp.on('Page.screencastFrame', event => {
      frames.push(event.data);
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // Actual wheel scrolling can paint intermediate compositor frames that
    // scrollIntoView + a final screenshot would miss.
    for (const distance of [480, 480, 480, -480, -480, -480]) {
      await page.mouse.wheel(0, distance);
      await page.waitForTimeout(60);
    }
    await cdp.send('Page.stopScreencast');
    const decoder = await context.newPage();
    const samples = await decoder.evaluate(async frames => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      const samples = [];
      for (const data of frames) {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        canvas.width = image.width; canvas.height = image.height; ctx.drawImage(image, 0, 0);
        // Every row begins with a keyword at the fixture's left margin.
        const pixels = ctx.getImageData(8, 120, 22, 480).data;
        let red = -255, ink = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) {
            ink++; red = Math.max(red, pixels[i] - pixels[i + 1]);
          }
        }
        samples.push({ ink, red });
      }
      return samples;
    }, frames);
    await decoder.close();
    expect(samples.length).toBeGreaterThan(2);
    expect(samples.filter(sample => sample.ink < 20 || sample.red < 150)).toEqual([]);
    for (const line of ['#LC900', '#LC1800', '#LC1']) {
      await page.locator(line).scrollIntoViewIfNeeded();
      await expect(page.locator(line)).toBeInViewport();
      expect(await covered()).toBe(1800);
      expect(await page.locator(line).evaluate(e => getComputedStyle(e, '::highlight(ugh-keyword)').color))
        .not.toBe(await page.locator(line).evaluate(e => getComputedStyle(e).color));
    }
    expect(await page.evaluate(() => [...CSS.highlights].map(([type, ranges]) => [type, ranges.size]))).toEqual(sizes);
    expect(await page.locator('.react-code-lines').innerHTML()).toBe(before);
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
