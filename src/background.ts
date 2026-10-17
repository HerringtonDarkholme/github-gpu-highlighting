import { IDLE_ALARM, isGitHub, RuntimeHost } from './runtime-host';
import { readResults, rememberResult } from './result-cache';

const host = new RuntimeHost();
const sync = () => { void host.sync().catch(() => {}); };

chrome.tabs.onCreated.addListener(sync);
chrome.tabs.onRemoved.addListener(sync);
chrome.tabs.onReplaced.addListener(sync);
chrome.tabs.onUpdated.addListener((_id, changes) => {
  if (changes.url || changes.status === 'loading' || changes.status === 'complete') sync();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) sync();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === IDLE_ALARM) void host.idle(alarm).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background') return;
  if (message.type === 'bootstrap' && sender.tab && isGitHub(sender.url)) {
    void Promise.all([chrome.storage.local.get('enabled'), readResults()]).then(([settings, cache]) => {
      respond({ enabled: settings.enabled !== false, cache });
    }, () => respond({ enabled: true, cache: [] }));
    return true;
  }
  if (message.type !== 'parse') return;
  void host.parse(message.source, sender).then(async reply => {
    if (reply.spans) await rememberResult({ source: message.source, spans: reply.spans });
    respond(reply);
  });
  return true;
});
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
// Reconcile in the event that woke the worker. An unconditional startup sync
// would re-arm an already-fired idle alarm before onAlarm could close the host.
