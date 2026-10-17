import type { Status } from './types';
import { animationSettings } from './animation-settings';

const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const availability = document.querySelector<HTMLElement>('#availability')!;
const files = document.querySelector<HTMLElement>('#files')!;
const duration = document.querySelector<HTMLInputElement>('#duration')!;
let animationEdited = false;
function showAnimation(value: unknown): void {
  const settings = animationSettings(value);
  duration.value = String(settings.durationMs);
}
duration.addEventListener('change', () => {
  animationEdited = true;
  const settings = animationSettings({ durationMs: duration.valueAsNumber });
  showAnimation(settings);
  void chrome.storage.local.set({ animation: settings });
});
let tabId: number | undefined;
let request = 0;

async function refresh(): Promise<void> {
  const version = ++request;
  try {
    if (tabId === undefined) throw new Error('No tab');
    const status: Status = await chrome.tabs.sendMessage(tabId, { type: 'status' });
    if (version !== request) return;
    enabled.checked = status.enabled;
    availability.textContent = status.availability;
    files.replaceChildren();
    for (const file of status.files) {
      const row = document.createElement('div'); row.className = 'file';
      const name = document.createElement('div'); name.className = 'name'; name.textContent = file.label;
      const actions = document.createElement('div'); actions.className = 'actions';
      const state = document.createElement('small'); state.textContent = file.state;
      const force = document.createElement('button'); force.textContent = 'Force highlight';
      force.disabled = !status.enabled || file.forced || file.state === 'Skipped: size limit' || /unavailable|failed/i.test(status.availability);
      force.addEventListener('click', async () => {
        force.disabled = true;
        await chrome.tabs.sendMessage(tabId!, { type: 'force', id: file.id });
        await refresh();
      });
      actions.append(state, force); row.append(name, actions); files.append(row);
    }
    if (!status.files.length) files.textContent = status.enabled ? 'No supported code blocks on this page.' : 'Highlighting is disabled.';
  } catch {
    if (version === request) { availability.textContent = 'Open a GitHub code page. Reload tabs opened before installation.'; files.replaceChildren(); }
  }
}

enabled.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: enabled.checked });
  await refresh();
});
void (async () => {
  const value = await chrome.storage.local.get(['enabled', 'animation']);
  if (!animationEdited) showAnimation(value.animation);
  enabled.checked = value.enabled !== false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await refresh();
  window.setInterval(() => void refresh(), 1000);
})();
