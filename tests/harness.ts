import { Controller } from '../src/controller';
import { discover, hasSyntax, sourceOf } from '../src/dom';
import { Lexer } from '../src/lexer';
import { makeRanges, Painter, snapshot, snapshotFile } from '../src/render';
import { fileSource, embeddedFileSource } from '../src/file-source';
import type { Span } from '../src/types';
import { Reveal } from '../src/reveal';

let calls: string[] = [];
let pending: (() => void) | undefined;
let controller: Controller;
Object.assign(window, { testApi: {
  discover, hasSyntax, sourceOf, snapshot, snapshotFile, fileSource, embeddedFileSource, makeRanges, Lexer, Painter, Reveal,
  calls: () => calls,
  controller: () => controller,
  release: () => pending?.(),
  start: (options: { delay?: boolean; fail?: boolean; unavailable?: boolean; plain?: boolean; seedBeforePaint?: boolean } = {}) => {
    calls = [];
    const lexer = new Lexer(async source => {
      calls.push(source);
      if (options.delay) await new Promise<void>(resolve => { pending = resolve; });
      if (options.fail) throw new Error('GPU failed');
      return source.length ? [{ type: options.plain ? 'plain' : 'keyword', start: 0, end: source.length }] satisfies Span[] : [];
    }, () => !options.unavailable);
    if (options.seedBeforePaint !== undefined) {
      lexer.seed(discover().flatMap(surface => surface.groups.map(group => {
        const source = snapshot(group).source;
        return { source, spans: [{ type: 'keyword', start: 0, end: source.length }] satisfies Span[] };
      })), options.seedBeforePaint);
    }
    controller = new Controller(lexer);
    controller.start();
    return controller.status();
  },
} });
