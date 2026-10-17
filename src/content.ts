import { Controller } from './controller';

const controller = new Controller();
// Register before the async read so a quick toggle can't be missed at startup.
let changed = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) {
    changed = true;
    controller.setEnabled(changes.enabled.newValue !== false);
  }
});
void chrome.storage.local.get('enabled').then(value => {
  controller.start(changed ? controller.status().enabled : value.enabled !== false);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'status') respond(controller.status());
  if (message?.type === 'force' && Number.isInteger(message.id)) {
    controller.force(message.id);
    respond(controller.status());
  }
});
