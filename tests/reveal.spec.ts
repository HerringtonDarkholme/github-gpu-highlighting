import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(new URL('./fixtures/surfaces.html', import.meta.url), 'utf8');
let harness: string;
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120' })).outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.route('https://github.com/**', route => route.fulfill({ body: fixture, contentType: 'text/html; charset=utf-8' }));
  await page.goto('https://github.com/test/repo/blob/main/example.invented');
  await page.addStyleTag({ path: 'public/content.css' });
  await page.addScriptTag({ content: harness });
  await page.evaluate(() => {
    document.querySelector('.file')!.remove(); document.querySelector('.markdown-body')!.remove();
    // Production must use CSS transitions, never Element.animate(). Tests may
    // seek the browser-created CSSTransition to inspect exact color frames.
    Element.prototype.animate = () => { throw new Error('Web Animations API must not be used'); };
  });
  await page.clock.install();
});

async function delayed(page: Page, plain = false) {
  await page.evaluate(plain => (window as any).testApi.start({ delay: true, plain }), plain);
  await page.clock.runFor(180);
  await page.evaluate(() => (window as any).testApi.release());
  await page.clock.runFor(1);
}
async function finish(page: Page) {
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.clock.runFor(520);
}
async function colorAt(page: Page, time: number) {
  return page.evaluate(time => {
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time; }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    return [...document.querySelectorAll('.react-file-line')].map(row => {
      ctx.fillStyle = getComputedStyle(row, '::highlight(ugh-keyword)').color;
      ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
    });
  }, time);
}

test('one native CSS transition fades all lines over 420 ms and restores markup', async ({ page }) => {
  const before = await page.locator('main').innerHTML();
  const nodes = await page.locator('.react-file-line').elementHandles();
  await delayed(page);
  expect(await page.evaluate(() => document.getAnimations().map(animation => ({
    css: animation instanceof CSSTransition,
    property: (animation as CSSTransition).transitionProperty,
    duration: animation.effect!.getTiming().duration,
    root: (animation.effect as KeyframeEffect).target!.matches('.react-code-lines'),
  })))).toEqual([{ css: true, property: '--ugh-reveal', duration: 420, root: true }]);
  const initial = await colorAt(page, 0), mid = await colorAt(page, 210), final = await colorAt(page, 420);
  expect(initial).toEqual([[31, 35, 40, 255], [31, 35, 40, 255]]);
  expect(final).toEqual([[207, 34, 46, 255], [207, 34, 46, 255]]);
  expect(mid[0][0]).toBeGreaterThan(initial[0][0]);
  expect(mid[0][0]).toBeLessThan(final[0][0]);
  expect(mid[0]).toEqual(mid[1]);
  for (const node of nodes) expect(await node.evaluate(element => element.isConnected)).toBe(true);
  await finish(page);
  expect(await page.locator('main').innerHTML()).toBe(before);
});

test('fast inference still fades; all-plain results do not animate', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await page.clock.runFor(50);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(1);
  await page.evaluate(() => (window as any).testApi.controller().stop());
  await delayed(page, true);
  expect(await page.evaluate(() => document.getAnimations().map(animation => ({ type: animation.constructor.name, state: animation.playState, target: (animation.effect as KeyframeEffect).target!.outerHTML })))).toEqual([]);
});

for (const beforePaint of [false, true]) {
  test(`startup cache ${beforePaint ? 'before paint preserves colors' : 'after plain text fades in'}`, async ({ page }) => {
    await page.evaluate(beforePaint => (window as any).testApi.start({ seedBeforePaint: beforePaint }), beforePaint);
    expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(beforePaint ? 0 : 1);
  });
}

test('disabling fades back to original colors before removing ranges; enabling fades cached results', async ({ page }) => {
  const before = await page.locator('main').innerHTML();
  await delayed(page); await finish(page);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(false));
  expect(await page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  const initial = await colorAt(page, 0), mid = await colorAt(page, 210), final = await colorAt(page, 420);
  expect(initial[0]).toEqual([207, 34, 46, 255]);
  expect(mid[0][0]).toBeLessThan(initial[0][0]);
  expect(mid[0][0]).toBeGreaterThan(final[0][0]);
  expect(final[0]).toEqual([31, 35, 40, 255]);
  await finish(page);
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  expect(await page.locator('main').innerHTML()).toBe(before);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(true));
  expect((await colorAt(page, 0))[0]).toEqual([31, 35, 40, 255]);
  expect((await colorAt(page, 210))[0][0]).toBeGreaterThan(31);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
});

test('rapid toggle reversals continue from the current color without clearing ranges', async ({ page }) => {
  await delayed(page); await finish(page);
  const result = await page.evaluate(() => {
    const api = (window as any).testApi, root = document.querySelector('.react-code-lines')!;
    const progress = () => Number(getComputedStyle(root).getPropertyValue('--ugh-reveal'));
    api.controller().setEnabled(false);
    const fadeOut = document.getAnimations()[0]; fadeOut.pause(); fadeOut.currentTime = 210;
    const previous = progress();
    api.controller().setEnabled(true);
    return { previous, next: progress(), ranges: CSS.highlights.size, calls: api.calls().length,
      duration: document.getAnimations()[0].effect!.getTiming().duration };
  });
  expect(result.previous).toBeCloseTo(0.5, 2);
  expect(result.next).toBeCloseTo(result.previous, 2);
  expect(result.duration).toBeCloseTo(210, 0);
  expect(result.ranges).toBeGreaterThan(0);
  expect(result.calls).toBe(1);
  await finish(page);
  expect(await page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
});

test('scrolling during a fade keeps visible and offscreen lines at the same progress', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.querySelector('.react-code-lines')!; root.replaceChildren();
    for (let i = 0; i < 1000; i++) {
      const line = document.createElement('div'); line.className = 'react-file-line'; line.textContent = `yield ${i}`; root.append(line);
    }
  });
  await delayed(page);
  const result = await page.evaluate(() => {
    const animation = document.getAnimations()[0]; animation.pause(); animation.currentTime = 210;
    const rows = [...document.querySelectorAll('.react-file-line')];
    const before = rows.map(row => getComputedStyle(row).getPropertyValue('--ugh-reveal'));
    const ranges = [...CSS.highlights.get('ugh-keyword')!];
    rows.at(-1)!.scrollIntoView();
    (window as any).testApi.controller().scan();
    rows[0].scrollIntoView();
    (window as any).testApi.controller().scan();
    return { same: document.getAnimations()[0] === animation,
      before: [...new Set(before)], after: [...new Set(rows.map(row => getComputedStyle(row).getPropertyValue('--ugh-reveal')))],
      ranges: ranges.every((range, i) => [...CSS.highlights.get('ugh-keyword')!][i] === range), calls: (window as any).testApi.calls().length };
  });
  expect(result).toEqual({ same: true, before: ['0.5'], after: ['0.5'], ranges: true, calls: 1 });
  await finish(page);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('scrolling and rerendering completed highlights never restart a fade', async ({ page }) => {
  await delayed(page); await finish(page);
  const result = await page.evaluate(() => {
    const api = (window as any).testApi, old = document.querySelector('.react-code-lines')!;
    old.replaceWith(old.cloneNode(true)); api.controller().scan();
    window.scrollTo(0, 500); api.controller().scan(); window.scrollTo(0, 0); api.controller().scan();
    return { transitions: document.getAnimations().length, calls: api.calls().length,
      connected: [...CSS.highlights.get('ugh-keyword')!].every(range => range.startContainer.isConnected),
      progress: getComputedStyle(document.querySelector('#LC1')!).getPropertyValue('--ugh-reveal') };
  });
  expect(result).toEqual({ transitions: 0, calls: 1, connected: true, progress: '1' });
});

test('replacing a line preserves the existing root transition and cleans cloned token styles', async ({ page }) => {
  await delayed(page);
  const result = await page.evaluate(() => {
    const animation = document.getAnimations()[0]; animation.pause(); animation.currentTime = 150;
    const line = document.querySelector('#LC1')!; line.replaceWith(line.cloneNode(true));
    (window as any).testApi.controller().scan();
    return { same: document.getAnimations()[0] === animation, progress: getComputedStyle(document.querySelector('#LC1')!).getPropertyValue('--ugh-reveal'), calls: (window as any).testApi.calls().length };
  });
  expect(result.same).toBe(true); expect(Number(result.progress)).toBeCloseTo(150 / 420, 4); expect(result.calls).toBe(1);
  await finish(page);
  expect(await page.locator('[data-ugh-fade], [style*="--ugh-"]').count()).toBe(0);
});

for (const move of [false, true]) {
  test(`replacing a root during a fade preserves progress with ${move ? 'moved' : 'cloned'} lines`, async ({ page }) => {
    await delayed(page);
    await page.clock.runFor(210);
    const result = await page.evaluate(move => {
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 210; }
      const old = document.querySelector('.react-code-lines')!;
      const root = old.cloneNode(!move) as Element;
      if (move) root.append(...old.childNodes);
      old.replaceWith(root); (window as any).testApi.controller().scan();
      return { progress: Number(getComputedStyle(root).getPropertyValue('--ugh-reveal')),
        duration: document.getAnimations()[0].effect!.getTiming().duration, calls: (window as any).testApi.calls().length };
    }, move);
    expect(result.progress).toBeCloseTo(0.5, 1);
    expect(result.duration).toBeLessThan(220);
    expect(result.calls).toBe(1);
    await finish(page);
    expect(await page.locator('[data-ugh-fade], [style*="--ugh-"]').count()).toBe(0);
  });
}

for (const change of ['theme', 'navigation', 'native syntax'] as const) {
  test(`${change} ends the transition without stale styles`, async ({ page }) => {
    await delayed(page);
    await page.evaluate(change => {
      const controller = (window as any).testApi.controller();
      if (change === 'theme') document.documentElement.setAttribute('data-color-mode', 'dark');
      if (change === 'navigation') { history.pushState(null, '', '/test/repo/issues/1'); controller.scan(); }
      if (change === 'native syntax') {
        const line = document.querySelector('#LC1')!;
        const token = document.createElement('span'); token.className = 'pl-k'; token.textContent = line.textContent;
        line.replaceChildren(token); controller.scan();
      }
    }, change);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.locator('[data-ugh-fade], [style*="--ugh-"]').count()).toBe(0);
    if (change !== 'theme') expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  });
}

test('reduced motion skips both directions and changing it finishes pending fade-outs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await delayed(page);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(false));
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(true));
  await finish(page);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(false));
  expect(await page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
  expect(await page.locator('[data-ugh-fade]').count()).toBe(0);
});

test('forced native tokens retain individual starting colors and original styles after fading out', async ({ page }) => {
  await page.evaluate(() => {
    const token = document.createElement('span'); token.className = 'pl-k'; token.style.fontWeight = 'bold'; token.textContent = 'invent';
    document.querySelector('#LC1')!.replaceChildren(token, document.createTextNode(' answer'));
    (window as any).testApi.start();
  });
  const before = await page.locator('.react-code-lines').innerHTML();
  await page.evaluate(() => { const c = (window as any).testApi.controller(); c.force(c.status().files[0].id); });
  await page.clock.runFor(40);
  const result = await page.evaluate(() => {
    const source = document.querySelector('#LC1')!;
    return { parent: getComputedStyle(source).getPropertyValue('--ugh-from-color'), token: getComputedStyle(source.querySelector('span')!).getPropertyValue('--ugh-from-color') };
  });
  expect(result).toEqual({ parent: 'rgb(31, 35, 40)', token: 'rgb(207, 34, 46)' });
  await finish(page);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(false));
  await finish(page);
  expect(await page.locator('.react-code-lines').innerHTML()).toBe(before);
});

test('returning to a cached file fades without rerunning inference', async ({ page }) => {
  await delayed(page); await finish(page);
  await page.evaluate(() => { history.pushState(null, '', '/test/repo/blob/main/cached.invented'); (window as any).testApi.controller().scan(); });
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(1);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
});
