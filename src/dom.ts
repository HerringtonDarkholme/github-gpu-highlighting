import type { Line, Surface } from './types';

export const SOURCE_SELECTOR = '.react-code-lines, table.highlight, table.diff-table, table:has(.diff-text-inner), .markdown-body pre';
export const LINE_SELECTOR = '.react-file-line, .blob-code-inner, .diff-text-inner, .markdown-body pre';

function lines(elements: Element[]): Line[] {
  return elements.map(element => ({ element, paint: true }));
}

export function sourceOf(group: Line[]): string {
  return group.map(line => line.element.textContent ?? '').join('\n');
}

// One actual syntax token is enough to respect GitHub's rendering. Diff word
// changes (.x), sign markers and line-number styles are deliberately excluded.
export function hasSyntax(surface: Surface): boolean {
  for (const { element } of surface.groups.flat()) {
    for (const node of [element, ...element.querySelectorAll('[class], [style]')]) {
      if (!node.textContent?.trim()) continue;
      if ([...node.classList].some(c => /^pl-/.test(c) || c === 'token')) return true;
      if ((node as HTMLElement).style.color) return true;
    }
  }
  return false;
}

function fileLabel(root: Element): string {
  const file = root.closest('.file, [data-testid="file-diff"], [data-testid="diff-file"]');
  return file?.querySelector('[data-path]')?.getAttribute('data-path')
    ?? file?.getAttribute('data-path')
    ?? root.getAttribute('aria-label')
    ?? 'File diff';
}

// Infer each visible hunk on each revision independently: a deletion followed by
// an addition must never be concatenated into a fictional source file.
function diffGroups(table: Element): Line[][] {
  const groups: Line[][] = [];
  let old: Line[] = [], next: Line[] = [];
  const flush = () => {
    if (old.some(l => l.paint)) groups.push(old);
    if (next.length) groups.push(next);
    old = []; next = [];
  };
  for (const row of table.querySelectorAll('tr')) {
    if (row.querySelector('.blob-code-hunk, .diff-text.hunk, .js-expandable-line, [data-expand-direction]')
        || row.matches('.js-expandable-line')) { flush(); continue; }
    const cells = [...row.querySelectorAll('.diff-text-inner, td.blob-code > .blob-code-inner, td.blob-code-inner:not(.blob-code-hunk)')];
    if (!cells.length) { flush(); continue; }
    for (const element of cells) {
      const cell = element.closest('td')!;
      const code = element.closest('.diff-text');
      const side = cell.getAttribute('data-split-side');
      const left = side === 'left' || cell.classList.contains('left-side');
      const right = side === 'right' || cell.classList.contains('right-side');
      const deletion = cell.classList.contains('blob-code-deletion') || code?.classList.contains('deletion');
      const addition = cell.classList.contains('blob-code-addition') || code?.classList.contains('addition');
      if (left) old.push({ element, paint: true });
      else if (right) next.push({ element, paint: true });
      else if (deletion) old.push({ element, paint: true });
      else if (addition) next.push({ element, paint: true });
      else {
        old.push({ element, paint: false });
        next.push({ element, paint: true });
      }
    }
  }
  flush();
  return groups;
}

export function discover(scope: ParentNode = document): Surface[] {
  const result: Surface[] = [];
  const seen = new Set<Element>();
  for (const root of scope.querySelectorAll(SOURCE_SELECTOR)) {
    if (root.closest('[contenteditable="true"], textarea') || seen.has(root)) continue;
    seen.add(root);
    if (root.matches('table') && root.querySelector('.diff-text-inner, .blob-code-marker')) {
      const groups = diffGroups(root);
      if (groups.length) result.push({ root, label: fileLabel(root), kind: 'diff', groups });
    } else if (root.matches('.react-code-lines, table.highlight')) {
      // Only repository blob views, never inline code snippets in unrelated UI.
      if (!/^\/[^/]+\/[^/]+\/blob\//.test(location.pathname)) continue;
      const elements = [...root.querySelectorAll('.react-file-line, td.blob-code')];
      if (elements.length) result.push({ root, label: decodeURIComponent(location.pathname.split('/').slice(4).join('/')), kind: 'file', groups: [lines(elements)] });
    } else if (root.matches('pre')) {
      const code = root.querySelector('code') ?? root;
      result.push({ root, label: `Markdown: ${(code.textContent ?? '').trim().slice(0,60)}`, kind: 'markdown', groups: [lines([code])] });
    }
  }
  return result;
}
