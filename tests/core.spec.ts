import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let harness: string;
const fixture = await readFile(new URL('./fixtures/surfaces.html', import.meta.url), 'utf8');
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120' })).outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.route('https://github.com/**', route => route.fulfill({ body: fixture, contentType: 'text/html' }));
  await page.goto('https://github.com/test/repo/blob/main/example.invented');
  await page.addStyleTag({ path: 'public/content.css' });
  await page.addScriptTag({ content: harness });
});

test('discovers React files, diff revisions/hunks, Markdown and native syntax', async ({ page }) => {
  const surfaces = await page.evaluate(() => (window as any).testApi.discover().map((s: any) => ({
    kind: s.kind, label: s.label, native: (window as any).testApi.hasSyntax(s),
    sources: s.groups.map((g: any) => (window as any).testApi.sourceOf(g)),
  })));
  expect(surfaces.map((s: any) => s.kind)).toEqual(['file', 'diff', 'markdown', 'markdown']);
  expect(surfaces[1]).toMatchObject({ native: false, label: 'example.invented', sources: ['invent greet(name)\n  yield 41', 'invent greet(name)\n  yield 42', 'finish'] });
  expect(surfaces[3].native).toBe(true);
});

test('UTF-16 spans cross nested text nodes and synthetic newlines without changing any DOM', async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = (window as any).testApi;
    const first = document.createElement('div'); first.textContent = 'a😀';
    const nested = document.createElement('a'); nested.href = '#L1'; nested.textContent = 'é'; first.append(nested);
    const second = document.createElement('div'); second.textContent = '"<script>"';
    document.querySelector('main')!.append(first, second);
    const before = first.outerHTML + second.outerHTML;
    const value = api.snapshot([{ element: first, paint: true }, { element: second, paint: true }]);
    const ranges = api.makeRanges(value, [{ type: 'string', start: 1, end: 8 }]);
    new api.Painter().set(first, ranges);
    return { source: value.source, selected: ranges.get('string').map((r: Range) => r.toString()), same: before === first.outerHTML + second.outerHTML };
  });
  expect(result).toEqual({ source: 'a😀é\n"<script>"', selected: ['😀', 'é', '"<'], same: true });
});

test('invalid model spans are rejected, plain gaps and unpainted context are handled', async ({ page }) => {
  expect(await page.evaluate(() => {
    const api = (window as any).testApi;
    const element = document.querySelector('#LC1')!;
    const value = api.snapshot([{ element, paint: true }]);
    const bad = [
      [{ type: 'keyword', start: -1, end: 1 }],
      [{ type: 'string', start: 0, end: 99999 }],
      [{ type: 'bogus', start: 0, end: 1 }],
      [{ type: 'string', start: 2, end: 3 }, { type: 'keyword', start: 1, end: 2 }],
      [{ type: 'keyword', start: 0.5, end: 1 }],
    ];
    const rejected = bad.every(spans => { try { api.makeRanges(value, spans); return false; } catch { return true; } });
    const unpainted = api.snapshot([{ element, paint: false }]);
    return rejected && api.makeRanges(unpainted, [{ type: 'comment', start: 0, end: 4 }]).size === 0;
  })).toBe(true);
});

test('unified and split React diffs omit signs, line numbers, and hunk headings', async ({ page }) => {
  const result = await page.evaluate(() => {
    const root = document.querySelector('#repo-content-pjax-container')!;
    // Fixture uses the React diff classes, including a real sign DOM node.
    const file = document.createElement('div'); file.className = 'file'; file.setAttribute('data-path', 'split.new');
    const table = document.createElement('table');
    const row = table.insertRow();
    for (const [side, text, kind] of [['left', 'old 😀', 'deletion'], ['right', 'new 😀', 'addition']]) {
      const cell = row.insertCell(); cell.className = `diff-text-cell ${side}-side`;
      const code = document.createElement('code'); code.className = `diff-text ${kind}`;
      const sign = document.createElement('span'); sign.className = 'diff-text-marker'; sign.textContent = side === 'left' ? '-' : '+';
      const content = document.createElement('div'); content.className = 'diff-text-inner'; content.textContent = text;
      code.append(sign, content); cell.append(code);
    }
    file.append(table); root.append(file);
    const api = (window as any).testApi;
    const surface = api.discover().find((s: any) => s.root === table);
    return surface.groups.map(api.sourceOf);
  });
  expect(result).toEqual(['old 😀', 'new 😀']);
});

test('automatic rendering preserves markup, handlers, anchors, diff backgrounds and native highlighting', async ({ page }) => {
  const before = await page.locator('main').innerHTML();
  const backgrounds = await page.locator('.blob-code-addition, .blob-code-deletion').evaluateAll(es => es.map(e => getComputedStyle(e).backgroundColor));
  await page.evaluate(() => {
    (window as any).clicked = 0;
    document.querySelector('#expand')!.addEventListener('click', () => (window as any).clicked++);
    (window as any).testApi.start();
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files.map((f: any) => f.state))).toEqual(['Highlighted', 'Highlighted', 'Highlighted', 'GitHub highlighting']);
  expect(await page.locator('main').innerHTML()).toBe(before);
  expect(await page.locator('.blob-code-addition, .blob-code-deletion').evaluateAll(es => es.map(e => getComputedStyle(e).backgroundColor))).toEqual(backgrounds);
  await page.locator('#expand').click();
  expect(await page.evaluate(() => (window as any).clicked)).toBe(1);
  await page.locator('#L1').click();
  expect(page.url()).toContain('#L1');
  expect(await page.evaluate(() => CSS.highlights.get('ugh-keyword')!.size)).toBeGreaterThan(0);
  const copied = await page.locator('.react-code-lines').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  });
  expect(copied).toContain('invent greet(name) => "hello 😀"');
});

test('duplicate scans, mutation settling, node replacement and source cache', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await expect.poll(() => page.evaluate(() => (window as any).testApi.calls().length)).toBe(5);
  await page.evaluate(() => { for (let i = 0; i < 10; i++) (window as any).testApi.controller().scan(); });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(5);
  await page.locator('#LC2').evaluate(e => { e.textContent = 'yield 100'; });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.calls().length)).toBe(6);
  await page.locator('#LC2').evaluate(e => { e.replaceWith(e.cloneNode(true)); });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(6);
  expect(await page.evaluate(() => [...CSS.highlights.get('ugh-keyword')!].every(r => r.startContainer.isConnected))).toBe(true);
});

test('native syntax arriving late removes extension paint; force can override it', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('Highlighted');
  await page.locator('#LC1').evaluate(e => {
    const token = document.createElement('span'); token.className = 'pl-k'; token.textContent = e.textContent; e.replaceChildren(token);
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('GitHub highlighting');
  await page.evaluate(() => { const c = (window as any).testApi.controller(); c.force(c.status().files[0].id); });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('Force highlighted');
});

test('navigation drops forced state and stale async results; dynamic Markdown is discovered', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start({ delay: true }));
  await expect.poll(() => page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
  await page.evaluate(() => {
    history.pushState(null, '', '/test/repo/issues/1');
    document.querySelector('#repo-content-pjax-container')!.replaceChildren();
    document.dispatchEvent(new Event('turbo:load'));
    (window as any).testApi.release();
  });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  expect(await page.evaluate(() => (window as any).testApi.controller().status().files)).toEqual([]);
  await page.evaluate(() => {
    const article = document.createElement('article'); article.className = 'markdown-body';
    const pre = document.createElement('pre'); pre.textContent = 'new language'; article.append(pre);
    document.querySelector('#repo-content-pjax-container')!.append(article);
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.calls().length)).toBe(2);
  await page.evaluate(() => (window as any).testApi.release());
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(1);
});

test('toggle cancels in-flight work, re-enabling uses cached spans, and pagehide clears paint', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('.file')!.remove(); document.querySelector('.markdown-body')!.remove();
    (window as any).testApi.start({ delay: true });
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
  await page.evaluate(() => { (window as any).testApi.controller().setEnabled(false); (window as any).testApi.release(); });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  await page.evaluate(() => (window as any).testApi.controller().setEnabled(true));
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(1);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(1);
});

test('GPU failures leave original source intact and do not retry on mutations', async ({ page }) => {
  const before = await page.locator('main').innerHTML();
  await page.evaluate(() => (window as any).testApi.start({ fail: true }));
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().availability)).toContain('failed');
  await page.evaluate(() => (window as any).testApi.controller().scan());
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  expect(await page.locator('main').innerHTML()).toBe(before);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(1);
});

test('missing WebGPU and oversized files never invoke the model', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('.file')!.remove(); document.querySelector('.markdown-body')!.remove();
    document.querySelector('#LC1')!.textContent = 'x'.repeat(60_001);
    (window as any).testApi.start({ unavailable: true });
  });
  expect(await page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('Skipped: size limit');
  expect(await page.evaluate(() => (window as any).testApi.calls())).toEqual([]);
  await page.locator('#LC1').evaluate(e => { e.textContent = 'small'; });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().availability)).toContain('unavailable');
  expect(await page.evaluate(() => (window as any).testApi.calls())).toEqual([]);
});

test('existing syntax and unrelated UI do not submit source for inference', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('.react-code-lines')!.replaceChildren(); document.querySelector('.file')!.remove();
    document.querySelector('.markdown-body pre')!.remove();
    (window as any).testApi.start();
  });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).testApi.calls())).toEqual([]);
});

test('theme switching updates highlight foreground while retaining diff backgrounds', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(1);
  const light = await page.locator('#LC1').evaluate(e => getComputedStyle(e, '::highlight(ugh-keyword)').color);
  const bg = await page.locator('.blob-code-addition').first().evaluate(e => getComputedStyle(e).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  const dark = await page.locator('#LC1').evaluate(e => getComputedStyle(e, '::highlight(ugh-keyword)').color);
  expect(light).toBe('rgb(207, 34, 46)');
  expect(dark).toBe('rgb(255, 123, 114)');
  expect(await page.locator('.blob-code-addition').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe(bg);
});

test('force does not survive a route change, even if GitHub reuses the same code root', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[3].state)).toBe('GitHub highlighting');
  await page.evaluate(() => {
    const c = (window as any).testApi.controller(); c.force(c.status().files[3].id);
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[3].state)).toBe('Force highlighted');
  await page.evaluate(() => {
    history.pushState(null, '', '/test/repo/blob/main/other.invented');
    document.dispatchEvent(new Event('soft-nav:end'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files.at(-1)?.state)).toBe('GitHub highlighting');
  expect(await page.evaluate(() => (window as any).testApi.controller().status().files.every((f: any) => !f.forced))).toBe(true);
});

test('a stalled GPU times out once and pending duplicates reuse the same request', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).testApi;
    let calls = 0;
    const lexer = new api.Lexer(() => { calls++; return new Promise(() => {}); }, () => true, 20);
    const first = lexer.parse('source');
    const same = first === lexer.parse('source');
    const results = await Promise.allSettled([first, lexer.parse('different')]);
    await lexer.parse('source').catch(() => {});
    return { same, calls, rejected: results.every(r => r.status === 'rejected'), failure: lexer.failure };
  });
  expect(result).toMatchObject({ same: true, calls: 1, rejected: true });
  expect(result.failure).toContain('failed');
});

test('legacy blob source tables preserve their line anchors', async ({ page }) => {
  const sources = await page.evaluate(() => {
    const table = document.createElement('table'); table.className = 'highlight';
    const row = table.insertRow(); const number = row.insertCell(); number.className = 'blob-num'; number.textContent = '10'; number.id = 'L10';
    const code = row.insertCell(); code.className = 'blob-code blob-code-inner'; code.id = 'LC10'; code.textContent = 'invent 42';
    document.querySelector('#repo-content-pjax-container')!.append(table);
    const api = (window as any).testApi;
    return api.discover().find((s: any) => s.root === table).groups.map(api.sourceOf);
  });
  expect(sources).toEqual(['invent 42']);
  expect(await page.locator('#L10').textContent()).toBe('10');
});

test('page processing budget also applies when forcing native files', async ({ page }) => {
  await page.evaluate(() => {
    const scope = document.querySelector('#repo-content-pjax-container')!; scope.replaceChildren();
    const article = document.createElement('article'); article.className = 'markdown-body';
    for (let i = 0; i < 5; i++) {
      const pre = document.createElement('pre');
      if (i === 4) {
        const token = document.createElement('span'); token.className = 'pl-k'; token.textContent = 'x'.repeat(50_000); pre.append(token);
      } else pre.textContent = `${i}`.repeat(50_000);
      article.append(pre);
    }
    scope.append(article); (window as any).testApi.start();
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files.map((f: any) => f.state))).toEqual(['Highlighted', 'Highlighted', 'Highlighted', 'Highlighted', 'GitHub highlighting']);
  await page.evaluate(() => { const c = (window as any).testApi.controller(); c.force(c.status().files[4].id); });
  expect(await page.evaluate(() => (window as any).testApi.controller().status().files[4].state)).toBe('Skipped: size limit');
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(4);
});

test('an oversized surface does not consume the budget for smaller files', async ({ page }) => {
  await page.evaluate(() => {
    const scope = document.querySelector('#repo-content-pjax-container')!; scope.replaceChildren();
    const article = document.createElement('article'); article.className = 'markdown-body';
    const huge = document.createElement('pre'); huge.textContent = 'x'.repeat(250_000);
    const small = document.createElement('pre'); small.textContent = 'invent small';
    article.append(huge, small); scope.append(article); (window as any).testApi.start();
  });
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files.map((f: any) => f.state))).toEqual(['Skipped: size limit', 'Highlighted']);
  expect(await page.evaluate(() => (window as any).testApi.calls())).toEqual(['invent small']);
});

test('startup discovers files immediately, without a settling timer', async ({ page }) => {
  await page.clock.install();
  const status = await page.evaluate(() => (window as any).testApi.start());
  expect(status.files).toHaveLength(4);
  expect(status.files[3].state).toBe('GitHub highlighting');
  await page.clock.runFor(50);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBe(5);
});

test('cached source replacement repaints synchronously without waiting for the queue', async ({ page }) => {
  await page.evaluate(() => (window as any).testApi.start());
  await expect.poll(() => page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('Highlighted');
  const result = await page.evaluate(() => {
    const api = (window as any).testApi;
    const before = api.calls().length;
    const line = document.querySelector('#LC1')!;
    line.replaceWith(line.cloneNode(true));
    api.controller().scan();
    return {
      state: api.controller().status().files[0].state,
      calls: api.calls().length - before,
      attached: [...CSS.highlights.get('ugh-keyword')!].every(r => r.startContainer.isConnected),
    };
  });
  expect(result).toEqual({ state: 'Highlighted', calls: 0, attached: true });
});

test('continuous source mutations cannot keep postponing highlighting', async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => {
    document.querySelector('.file')!.remove(); document.querySelector('.markdown-body')!.remove();
    (window as any).testApi.start();
  });
  await page.clock.runFor(50);
  await page.evaluate(() => {
    let i = 0;
    (window as any).storm = setInterval(() => { document.querySelector('#LC2')!.textContent = `yield ${++i}`; }, 8);
  });
  await page.clock.runFor(100);
  expect(await page.evaluate(() => (window as any).testApi.calls().length)).toBeGreaterThan(1);
  await page.evaluate(() => clearInterval((window as any).storm));
  await page.clock.runFor(50);
  expect(await page.evaluate(() => (window as any).testApi.controller().status().files[0].state)).toBe('Highlighted');
});

test('a request from a closed runtime cannot poison a retry, and completed page cache entries survive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).testApi;
    let rejectOld!: (error: Error) => void;
    const lexer = new api.Lexer((source: string) => source === 'pending'
      ? new Promise((_resolve, reject) => { rejectOld = reject; })
      : Promise.resolve([{ type: 'keyword', start: 0, end: source.length }]), () => true);
    await lexer.parse('cached');
    const old = lexer.parse('pending').catch(() => {});
    // Let the old request enter the runtime before it is disabled/recreated.
    await Promise.resolve();
    lexer.retry();
    const fresh = lexer.parse('fresh');
    rejectOld(new Error('Offscreen document closed'));
    await Promise.all([old, fresh]);
    return { failure: lexer.failure, cached: lexer.cached('cached'), fresh: lexer.cached('fresh') };
  });
  expect(result).toEqual({ failure: '', cached: [{ type: 'keyword', start: 0, end: 6 }], fresh: [{ type: 'keyword', start: 0, end: 5 }] });
});
