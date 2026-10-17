import { RuntimeHost, IDLE_ALARM, IDLE_MS } from '../src/runtime-host';

Object.assign(window, { makeHost: () => {
  let now = 0;
  let tabs: { id: number; url: string; pendingUrl?: string }[] = [];
  let enabled = true;
  let exists = false;
  let creates = 0, closes = 0, warms = 0;
  let alarm: { name: string; scheduledTime: number } | undefined;
  const api = {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => exists ? [{}] : [],
      sendMessage: async (message: { type: string }) => {
        if (message.type === 'warm') warms++;
        return { spans: [] };
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => { creates++; exists = true; },
      closeDocument: async () => { closes++; exists = false; },
    },
    storage: { local: { get: async () => ({ enabled }) } },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Tab closed'); return tab; },
    },
    alarms: {
      get: async () => alarm,
      clear: async () => { alarm = undefined; return true; },
      create: async (_name: string, info: { when: number }) => { alarm = { name: IDLE_ALARM, scheduledTime: info.when }; },
    },
  } as unknown as typeof chrome;
  let host = new RuntimeHost(api, () => now);
  return {
    sync: () => host.sync(),
    idle: (event = alarm!) => host.idle(event),
    parse: (source: string, id = 1) => host.parse(source, { url: 'https://github.com/test/repo', tab: { id } } as chrome.runtime.MessageSender),
    setTabs: (value: typeof tabs) => { tabs = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    advance: (ms: number) => { now += ms; },
    restartServiceWorker: () => { host = new RuntimeHost(api, () => now); },
    state: () => ({ now, exists, creates, closes, warms, alarm, idleMs: IDLE_MS }),
  };
} });
