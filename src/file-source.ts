import { MAX_SOURCE } from './limits';

// A file's source is independent of whichever rows GitHub currently mounts.
export interface FileSource { text: string; lines: string[]; offsets: number[] }
export function fileSource(lines: string[]): FileSource | undefined {
  let length = Math.max(0, lines.length - 1);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    if (typeof line !== 'string') return;
    length += line.length;
    if (length > MAX_SOURCE) return;
    offsets.push(offset); offset += line.length + 1;
  }
  return { text: lines.join('\n'), lines, offsets };
}

const embedded = new WeakMap<Element, { text: string; payload: any; source?: FileSource }>();
const textareas = new WeakMap<HTMLTextAreaElement, FileSource>();

export function renderedFileSource(): FileSource | undefined {
  // GitHub's read-only selection/copy textarea contains the entire file even
  // when the colored DOM is virtualized. React updates its value on navigation.
  const area = document.querySelector<HTMLTextAreaElement>('textarea#read-only-cursor-text-area[aria-readonly="true"], textarea[data-testid="read-only-cursor-text-area"][aria-readonly="true"]');
  if (!area) return;
  const text = area.value;
  let source = textareas.get(area);
  if (source?.text !== text) {
    source = text.length > MAX_SOURCE ? { text, lines: [], offsets: [] } : fileSource(text.split('\n'));
    if (source) textareas.set(area, source);
  }
  return source;
}

export function embeddedFileSource(): FileSource | undefined {
  if (!/^\/[^/]+\/[^/]+\/blob\//.test(location.pathname)) return;
  for (const script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
    try {
      const text = script.textContent ?? '';
      let entry = embedded.get(script);
      if (entry?.text !== text) {
        entry = { text, payload: JSON.parse(text).payload };
        embedded.set(script, entry);
      }
      const payload = entry!.payload;
      const route = payload?.codeViewBlobLayoutRoute;
      // Old embedded data can remain after React navigation. Never use a
      // different file or revision's offsets, even when its lines look alike.
      const url = new URL(route?.blob?.displayUrl, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || route.blob.truncated) continue;
      const lines = payload['codeViewBlobLayoutRoute.StyledBlob']?.rawLines ?? route.StyledBlob?.rawLines;
      if (Array.isArray(lines)) return entry!.source ??= fileSource(lines);
    } catch { /* Missing, partial or unfamiliar GitHub payload: use DOM source. */ }
  }
}
