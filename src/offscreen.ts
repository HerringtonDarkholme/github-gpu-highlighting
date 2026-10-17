import type { LexerReply } from './protocol';

const worker = new Worker(chrome.runtime.getURL('gpu-worker.js'));
const pending = new Map<number, { respond: (reply: LexerReply) => void; timer: ReturnType<typeof setTimeout> }>();
let nextId = 0;
let failure = '';

worker.onmessage = (event: MessageEvent<LexerReply & { id: number }>) => {
  const entry = pending.get(event.data.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(event.data.id);
  entry.respond(event.data);
};
worker.onerror = () => {
  failure = 'WebGPU worker unavailable';
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.respond({ error: failure }); }
  pending.clear();
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type !== 'warm' && message.type !== 'parse') return;
  if (failure) { respond({ error: failure }); return; }
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    respond({ error: 'WebGPU worker timed out' });
  }, 25_000);
  pending.set(id, { respond, timer });
  worker.postMessage({ id, type: message.type, source: message.source });
  return true;
});
window.addEventListener('pagehide', () => worker.terminate());
