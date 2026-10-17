import { Controller } from '../src/controller';
import { discover, hasSyntax, sourceOf } from '../src/dom';
import { Lexer } from '../src/lexer';
import { makeRanges, Painter, snapshot } from '../src/render';
import type { Span } from '../src/types';

let calls: string[] = [];
let pending: (() => void) | undefined;
let controller: Controller;
Object.assign(window, { testApi: {
  discover, hasSyntax, sourceOf, snapshot, makeRanges, Lexer, Painter,
  calls: () => calls,
  controller: () => controller,
  release: () => pending?.(),
  start: (options: { delay?: boolean; fail?: boolean; unavailable?: boolean } = {}) => {
    calls = [];
    const lexer = new Lexer(async source => {
      calls.push(source);
      if (options.delay) await new Promise<void>(resolve => { pending = resolve; });
      if (options.fail) throw new Error('GPU failed');
      return source.length ? [{ type: 'keyword', start: 0, end: source.length }] satisfies Span[] : [];
    }, () => !options.unavailable);
    controller = new Controller(lexer);
    controller.start();
    return controller.status();
  },
} });
