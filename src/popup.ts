import type { FileStatus, Status } from './types';
import { animationSettings } from './animation-settings';

const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const enabledLabel = document.querySelector<HTMLElement>('#enabled-label')!;
const availability = document.querySelector<HTMLElement>('#availability')!;
const files = document.querySelector<HTMLElement>('#files')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const template = document.querySelector<HTMLTemplateElement>('#file-template')!;
const duration = document.querySelector<HTMLInputElement>('#duration')!;
let animationEdited = false;
function showAnimation(value: unknown): void { duration.value = String(animationSettings(value).durationMs); }
duration.addEventListener('change', () => {
  animationEdited = true;
  const settings = animationSettings({ durationMs: duration.valueAsNumber });
  showAnimation(settings);
  void chrome.storage.local.set({ animation: settings });
});
let tabId: number | undefined;
let request = 0;
interface Card {
  root: HTMLElement; name: HTMLElement; badge: HTMLElement; state: HTMLElement;
  button: HTMLButtonElement; file: FileStatus; busy: boolean;
}
const cards = new Map<string, Card>();
const widths = { highlighted: 82, forced: 58, off: 38, pending: 64, native: 58, unavailable: 92, skipped: 72 };
function stateOf(file: FileStatus, on: boolean): keyof typeof widths {
  if (!on) return 'off';
  if (file.state === 'Pending') return 'pending';
  if (file.state === 'GitHub highlighting') return 'native';
  if (file.state === 'Unavailable') return 'unavailable';
  if (file.state.startsWith('Skipped')) return 'skipped';
  return file.forced ? 'forced' : 'highlighted';
}
function showEnabled(on: boolean): void {
  enabled.checked = on;
  enabledLabel.textContent = on ? 'On' : 'Off';
}
function showAvailability(message: string, on: boolean, connected = true): void {
  const error = /unavailable|failed/i.test(message);
  availability.textContent = !connected ? 'Open a GitHub code page' : error ? 'Highlighting unavailable' : on ? 'Runs on WebGPU' : 'WebGPU idle';
  availability.title = message;
  availability.parentElement!.dataset.state = error ? 'error' : !connected || !on ? 'idle' : 'ready';
}
function createCard(file: FileStatus): Card {
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const card: Card = {
    root, name: root.querySelector('.name')!, badge: root.querySelector('.badge')!,
    state: root.querySelector('small')!, button: root.querySelector('button')!, file, busy: false,
  };
  card.button.addEventListener('click', async () => {
    card.busy = true; card.button.disabled = true;
    try {
      await chrome.tabs.sendMessage(tabId!, { type: card.file.forced ? 'unforce' : 'force', id: card.file.id });
    } finally { card.busy = false; await refresh(); }
  });
  return card;
}
function renderFiles(status: Status): void {
  // Keep the current cards while disabling, so the badge and toggle can
  // transition to Off instead of disappearing. A fresh popup has no stale cards.
  const values = !status.enabled && !status.files.length
    ? [...cards.values()].map(card => ({ ...card.file, forced: false, state: 'Off' })) : status.files;
  const occurrences = new Map<string, number>(), current = new Set<string>();
  let cursor = files.firstElementChild;
  for (const file of values) {
    const index = occurrences.get(file.label) ?? 0; occurrences.set(file.label, index + 1);
    const key = `${file.label}\n${index}`;
    let card = cards.get(key);
    if (!card) { card = createCard(file); cards.set(key, card); }
    current.add(key); card.file = file;
    const state = stateOf(file, status.enabled);
    card.name.textContent = file.label; card.name.title = file.label;
    card.badge.dataset.state = state;
    card.badge.style.setProperty('--pill-width', `${widths[state]}px`);
    card.state.textContent = status.enabled ? file.state : 'Off';
    card.badge.title = card.state.textContent;
    card.button.textContent = file.forced ? 'Stop forcing' : 'Force highlight';
    card.button.dataset.forced = String(file.forced);
    card.button.disabled = card.busy || !status.enabled || (!file.forced && (file.state === 'Skipped: size limit' || /unavailable|failed/i.test(status.availability)));
    if (card.root !== cursor) files.insertBefore(card.root, cursor);
    cursor = card.root.nextElementSibling;
  }
  for (const [key, card] of cards) if (!current.has(key)) { card.root.remove(); cards.delete(key); }
  empty.hidden = values.length > 0;
  empty.textContent = status.enabled ? 'No supported code blocks on this page.' : 'Highlighting is disabled.';
}
async function refresh(): Promise<void> {
  const version = ++request;
  try {
    if (tabId === undefined) throw new Error('No tab');
    const status: Status = await chrome.tabs.sendMessage(tabId, { type: 'status' });
    if (version !== request) return;
    showEnabled(status.enabled);
    showAvailability(status.availability, status.enabled);
    renderFiles(status);
  } catch {
    if (version !== request) return;
    showAvailability('Open a GitHub code page. Reload tabs opened before installation.', enabled.checked, false);
    cards.clear(); files.replaceChildren(); empty.hidden = false;
    empty.textContent = 'Open a GitHub code page to see its highlighting status.';
  }
}
enabled.addEventListener('change', async () => {
  showEnabled(enabled.checked);
  // Update the visible state immediately; storage notifies all GitHub tabs.
  for (const card of cards.values()) {
    card.badge.dataset.state = enabled.checked ? stateOf(card.file, true) : 'off';
    card.badge.style.setProperty('--pill-width', `${widths[enabled.checked ? stateOf(card.file, true) : 'off']}px`);
    card.state.textContent = enabled.checked ? card.file.state : 'Off';
    card.button.disabled = !enabled.checked;
  }
  await chrome.storage.local.set({ enabled: enabled.checked });
  await refresh();
});
void (async () => {
  const value = await chrome.storage.local.get(['enabled', 'animation']);
  if (!animationEdited) showAnimation(value.animation);
  showEnabled(value.enabled !== false);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await refresh();
  window.setInterval(() => void refresh(), 1000);
})();
