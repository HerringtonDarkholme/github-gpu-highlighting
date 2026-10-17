import { parseInBackground } from './protocol';
import { MAX_SOURCE } from './limits';
import type { Span } from './types';

export type Parse = (source: string) => Promise<Span[]>;
export { MAX_SOURCE } from './limits';

// Keep result caching in the page. Only the shared worker imports gpu-lexer.
export class Lexer {
  private cache = new Map<string, { promise: Promise<Span[]>; spans?: Span[] }>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  failure = '';
  constructor(private parseSource: Parse = parseInBackground, private available = () => true, private timeoutMs = 30_000) {}

  cached(source: string): Span[] | undefined { return this.cache.get(source)?.spans; }
  retry(): void {
    this.generation++;
    this.failure = '';
    this.tail = Promise.resolve();
    for (const [source, entry] of this.cache) {
      if (entry.spans === undefined) this.cache.delete(source);
    }
  }

  parse(source: string): Promise<Span[]> {
    if (source.length > MAX_SOURCE) return Promise.reject(new Error('Source too large'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    const cached = this.cache.get(source);
    if (cached) return cached.promise;
    const generation = this.generation;
    const result = this.tail.then(async () => {
      if (generation !== this.generation) throw new Error('Superseded lexer request');
      if (this.failure) throw new Error(this.failure);
      if (!this.available()) throw new Error('WebGPU unavailable');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.parseSource(source),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('WebGPU timed out')), this.timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }).then(spans => {
      const entry = this.cache.get(source);
      if (entry?.promise === result) entry.spans = spans;
      return spans;
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.failure = 'WebGPU unavailable or model initialization failed. Disable and re-enable highlighting to retry.';
        for (const [source, entry] of this.cache) {
          if (entry.spans === undefined) this.cache.delete(source);
        }
      }
      throw error;
    });
    this.tail = result.catch(() => {});
    this.cache.set(source, { promise: result });
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
