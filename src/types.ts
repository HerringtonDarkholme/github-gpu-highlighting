export const TOKEN_TYPES = ['plain', 'comment', 'string', 'number', 'keyword', 'type', 'function', 'constant', 'operator'] as const;
export type TokenType = typeof TOKEN_TYPES[number];
export interface Span { type: TokenType; start: number; end: number }
export interface Line { element: Element; paint: boolean }
export interface Surface {
  root: Element;
  label: string;
  kind: 'file' | 'diff' | 'markdown';
  groups: Line[][];
}
export interface FileStatus { id: number; label: string; state: string; forced: boolean }
export interface Status { enabled: boolean; availability: string; files: FileStatus[] }
