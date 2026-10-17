import type { Span } from './types';

export interface LexerReply { spans?: Span[]; error?: string }

export async function parseInBackground(source: string): Promise<Span[]> {
  const reply: LexerReply = await chrome.runtime.sendMessage({ target: 'background', type: 'parse', source });
  if (!reply || reply.error || !Array.isArray(reply.spans)) throw new Error(reply?.error ?? 'Background lexer unavailable');
  return reply.spans;
}
