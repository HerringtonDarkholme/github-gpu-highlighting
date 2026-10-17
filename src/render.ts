import { TOKEN_TYPES, type Line, type Span, type TokenType } from './types';

interface Piece { node: Text; start: number; end: number; paint: boolean }
export interface Snapshot { source: string; pieces: Piece[]; lines: Line[]; texts: string[] }

export function snapshot(lines: Line[]): Snapshot {
  const pieces: Piece[] = [];
  const texts: string[] = [];
  let offset = 0;
  for (const { element, paint } of lines) {
    const text = element.textContent ?? '';
    texts.push(text);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      pieces.push({ node: node as Text, start: offset, end: offset + length, paint });
      offset += length;
    }
    offset++; // A synthetic newline between DOM rows; never a DOM modification.
  }
  return { source: texts.join('\n'), pieces, lines, texts };
}

export function isCurrent(value: Snapshot): boolean {
  return value.lines.every(({ element }, i) => element.isConnected && element.textContent === value.texts[i])
    && value.pieces.every(p => p.node.isConnected);
}

export type Ranges = Map<TokenType, Range[]>;

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
      const range = document.createRange();
      range.setStart(piece.node, start);
      range.setEnd(piece.node, end);
      const ranges = result.get(span.type) ?? [];
      ranges.push(range);
      result.set(span.type, ranges);
    }
  }
  return result;
}

export class Painter {
  private layers = new Map<Element, Ranges>();
  supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  set(root: Element, ranges: Ranges): void { this.layers.set(root, ranges); this.commit(); }
  remove(root: Element): void { if (this.layers.delete(root)) this.commit(); }
  clear(): void { this.layers.clear(); this.commit(); }
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
