import { parse } from 'gpu-lexer';
import { MAX_SOURCE } from './limits';
import type { LexerReply } from './protocol';

let failure = '';
async function infer(source: string) {
  if (failure) throw new Error(failure);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      parse(source),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('WebGPU timed out')), 20_000);
      }),
    ]);
  } catch (error) {
    failure = 'WebGPU unavailable or model inference failed';
    throw error;
  } finally { clearTimeout(timer); }
}
// parse is the package's only public API. A real token initializes its singleton
// before the first source arrives; empty/whitespace input would not do so.
const ready = infer('x');
void ready.catch(() => {});

self.onmessage = (event: MessageEvent) => {
  const { id, type, source } = event.data;
  void (async (): Promise<LexerReply> => {
    await ready;
    if (type === 'warm') return {};
    if (type !== 'parse' || typeof source !== 'string' || source.length > MAX_SOURCE) throw new Error('Invalid lexer request');
    return { spans: await infer(source) };
  })().then(reply => self.postMessage({ id, ...reply }), () => {
    self.postMessage({ id, error: failure || 'WebGPU unavailable or inference failed' });
  });
};
