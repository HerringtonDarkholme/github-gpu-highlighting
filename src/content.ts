import { Controller } from './controller';
import { Lexer } from './lexer';
import type { BootstrapReply } from './protocol';
import { saveReloadCache, takeReloadCache } from './reload-cache';
import { animationSettings } from './animation-settings';

const lexer = new Lexer();
const controller = new Controller(lexer);
let started = false;
window.addEventListener('pagehide', () => saveReloadCache(controller.status().enabled, lexer.completed()));
// Register before the async read so a quick toggle can't be missed at startup.
let changed = false;
let animationChanged = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.animation) {
    animationChanged = true;
    controller.setAnimation(animationSettings(changes.animation.newValue));
  }
  if (area === 'local' && changes.enabled) {
    changed = true;
    controller.setEnabled(changes.enabled.newValue !== false);
  }
});
const reloadCache = takeReloadCache();
if (reloadCache) {
  lexer.seed(reloadCache, true);
  controller.start(true);
  started = true;
}
void chrome.runtime.sendMessage({ target: 'background', type: 'bootstrap' }).then((value: BootstrapReply) => {
  lexer.seed(value.cache);
  if (!animationChanged) controller.setAnimation(animationSettings(value.animation));
  const enabled = changed ? controller.status().enabled : value.enabled;
  if (!started) controller.start(enabled);
  else if (controller.status().enabled !== enabled) controller.setEnabled(enabled);
}).catch(async () => {
  const value = await chrome.storage.local.get(['enabled', 'animation']).catch(() => ({ enabled: undefined, animation: undefined }));
  if (!animationChanged) controller.setAnimation(animationSettings(value.animation));
  const enabled = changed ? controller.status().enabled : value.enabled !== false;
  if (!started) controller.start(enabled);
  else if (controller.status().enabled !== enabled) controller.setEnabled(enabled);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'status') respond(controller.status());
  if (message?.type === 'force' && Number.isInteger(message.id)) {
    controller.force(message.id);
    respond(controller.status());
  }
});
