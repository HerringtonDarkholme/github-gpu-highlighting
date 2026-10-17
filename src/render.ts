import { TOKEN_TYPES, type Line, type Span, type TokenType } from './types';
import { Reveal } from './reveal';
import type { FileSource } from './file-source';

interface Piece { node: Text; start: number; end: number; paint: boolean }
export interface Snapshot { source: string; pieces: Piece[]; lines: Line[]; texts: string[] }

export function snapshot(lines: Line[]): Snapshot {
  return snapshotAt(lines);
}

// Missing rows leave gaps in source offsets, rather than disappearing from
// the model input. IDs and text must both match before reusing a file result.
export function snapshotFile(lines: Line[], source: FileSource): Snapshot | undefined {
  const offsets: number[] = [];
  const placeholders = new Set<number>();
  let previous = 0;
  for (const [i, { element }] of lines.entries()) {
    const match = /^LC(\d+)$/.exec(element.id);
    const number = match ? Number(match[1]) : 0;
    if (number <= previous || number > source.lines.length) return;
    const text = element.textContent ?? '', expected = source.lines[number - 1];
    // GitHub mounts an extra newline text node to give an empty code row
    // height. It is a DOM placeholder, not another newline in the source.
    if (expected === '' && text === '\n') placeholders.add(i);
    else if (text !== expected) return;
    previous = number;
    offsets.push(source.offsets[number - 1]);
  }
  return snapshotAt(lines, offsets, source.text, placeholders);
}

function snapshotAt(lines: Line[], offsets?: number[], source?: string, placeholders?: Set<number>): Snapshot {
  const pieces: Piece[] = [];
  const texts: string[] = [];
  let offset = 0;
  for (const [i, { element, paint }] of lines.entries()) {
    if (offsets) offset = offsets[i];
    const text = element.textContent ?? '';
    texts.push(text);
    if (placeholders?.has(i)) continue;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      pieces.push({ node: node as Text, start: offset, end: offset + length, paint });
      offset += length;
    }
    offset++; // A synthetic newline between DOM rows; never a DOM modification.
  }
  return { source: source ?? texts.join('\n'), pieces, lines, texts };
}

export function isCurrent(value: Snapshot): boolean {
  return value.lines.every(({ element }, i) => element.isConnected && element.textContent === value.texts[i])
    && value.pieces.every(p => p.node.isConnected);
}

export type Ranges = Map<TokenType, StaticRange[]>;

export function makeRanges(value: Snapshot, spans: Span[]): Ranges {
  // Reject bad model output as a whole, rather than rendering partial corruption.
  let previous = 0;
  for (const span of spans) {
    if (!TOKEN_TYPES.includes(span.type) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < previous || span.end < span.start || span.end > value.source.length) {
      throw new Error('Invalid lexer spans');
    }
    previous = span.end;
  }
  const result: Ranges = new Map();
  let first = 0;
  for (const span of spans) {
    while (first < value.pieces.length && value.pieces[first].end <= span.start) first++;
    for (let i = first; i < value.pieces.length; i++) {
      const piece = value.pieces[i];
      if (piece.start >= span.end) break;
      if (!piece.paint || piece.start === piece.end) continue;
      const start = Math.max(span.start, piece.start) - piece.start;
      const end = Math.min(span.end, piece.end) - piece.start;
      if (start >= end) continue;
      // Live Range endpoints jump to the parent when GitHub unmounts a row,
      // even if it reinserts that same text node. StaticRange keeps the model's
      // node/offset mapping intact across virtualization and node moves.
      const range = new StaticRange({ startContainer: piece.node, startOffset: start,
        endContainer: piece.node, endOffset: end });
      const ranges = result.get(span.type) ?? [];
      ranges.push(range);
      result.set(span.type, ranges);
    }
  }
  return result;
}

export class Painter {
  private layers = new Map<Element, Ranges>();
  private lines = new Map<Element, Element[]>();
  private reveal = new Reveal();
  supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  set(root: Element, ranges: Ranges, revealLines?: Element[], animate = true): void {
    if (revealLines) this.reveal.start(root, revealLines, animate);
    else this.reveal.cancel(root);
    this.layers.set(root, ranges);
    if (revealLines) this.lines.set(root, revealLines);
    else this.lines.delete(root);
    this.commit();
  }
  move(from: Element, to: Element): void {
    const ranges = this.layers.get(from);
    this.layers.delete(from);
    if (ranges) this.layers.set(to, ranges);
    const lines = this.lines.get(from);
    this.lines.delete(from);
    if (lines) this.lines.set(to, lines);
    this.reveal.move(from, to);
    // The caller rebinds cloned text ranges in this same scan. If React moved
    // the original text nodes, their existing ranges are already correct.
  }
  remove(root: Element): void {
    this.reveal.cancel(root); this.lines.delete(root);
    if (this.layers.delete(root)) this.commit();
  }
  clear(fade = false): void {
    for (const root of [...this.layers.keys()]) {
      if (fade && this.lines.has(root)) {
        this.reveal.hide(root, this.lines.get(root)!, () => {
          this.layers.delete(root); this.lines.delete(root); this.commit();
        });
      } else this.remove(root);
    }
  }
  private commit(): void {
    if (!this.supported) return;
    for (const type of TOKEN_TYPES) {
      const highlight = new Highlight();
      for (const ranges of this.layers.values()) {
        for (const range of ranges.get(type) ?? []) highlight.add(range);
      }
      highlight.priority = -1; // GitHub search/selection highlights retain precedence.
      if (highlight.size) CSS.highlights.set(`ugh-${type}`, highlight);
      else CSS.highlights.delete(`ugh-${type}`);
    }
  }
}
