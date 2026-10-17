import { MAX_SOURCE } from './limits';
import type { LexerReply } from './protocol';

export const IDLE_ALARM = 'gpu-lexer-idle';
export const IDLE_MS = 3 * 60_000;
export const isGitHub = (url?: string): boolean => !!url && /^https:\/\/github\.com\//.test(url);

// Lifecycle operations are serialized, inference is not held under this lock.
// Chrome's tab list, offscreen contexts and alarms survive service-worker naps.
export class RuntimeHost {
  private lifecycle: Promise<unknown> = Promise.resolve();
  constructor(private api: typeof chrome = chrome, private now = () => Date.now()) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }
  private async exists(): Promise<boolean> {
    const contexts = await this.api.runtime.getContexts({
      contextTypes: [this.api.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [this.api.runtime.getURL('offscreen.html')],
    });
    return contexts.length > 0;
  }
  private async ensure(): Promise<void> {
    if (await this.exists()) return;
    await this.api.offscreen.createDocument({
      url: 'offscreen.html', reasons: [this.api.offscreen.Reason.WORKERS],
      justification: 'Host the shared WebGPU lexer worker while GitHub tabs are open',
    });
  }
  private async enabled(): Promise<boolean> {
    return (await this.api.storage.local.get('enabled')).enabled !== false;
  }
  private async githubOpen(): Promise<boolean> {
    // Include in-progress visits so initialization can overlap GitHub's load.
    // Host-scoped permissions expose GitHub URLs without a general tabs grant.
    return (await this.api.tabs.query({})).some(tab => isGitHub(tab.url) || isGitHub(tab.pendingUrl));
  }

  sync(): Promise<void> {
    return this.run(async () => {
      if (!(await this.enabled())) {
        await this.api.alarms.clear(IDLE_ALARM);
        if (await this.exists()) await this.api.offscreen.closeDocument();
      } else if (await this.githubOpen()) {
        await this.api.alarms.clear(IDLE_ALARM);
        await this.ensure();
        // Fire-and-forget warming doesn't block lifecycle decisions for 20s.
        void this.api.runtime.sendMessage({ target: 'offscreen', type: 'warm' }).catch(() => {});
      } else if (await this.exists()) {
        // Do not reset an existing deadline on unrelated tabs or SW restarts.
        if (!(await this.api.alarms.get(IDLE_ALARM))) {
          await this.api.alarms.create(IDLE_ALARM, { when: this.now() + IDLE_MS });
        }
      } else await this.api.alarms.clear(IDLE_ALARM);
    });
  }

  idle(alarm: chrome.alarms.Alarm): Promise<void> {
    return this.run(async () => {
      const current = await this.api.alarms.get(IDLE_ALARM);
      // A queued alarm from an earlier idle period must not cancel a new grace
      // period after a GitHub tab was briefly reopened and closed again.
      if (current && current.scheduledTime > alarm.scheduledTime) return;
      if (await this.enabled() && await this.githubOpen()) {
        await this.api.alarms.clear(IDLE_ALARM); return;
      }
      if (this.now() < alarm.scheduledTime) {
        await this.api.alarms.create(IDLE_ALARM, { when: alarm.scheduledTime }); return;
      }
      if (await this.exists()) await this.api.offscreen.closeDocument();
      await this.api.alarms.clear(IDLE_ALARM);
    });
  }

  async parse(source: string, sender: chrome.runtime.MessageSender): Promise<LexerReply> {
    if (typeof source !== 'string' || source.length > MAX_SOURCE || !isGitHub(sender.url) || sender.tab?.id === undefined) {
      return { error: 'Invalid lexer request' };
    }
    try {
      await this.run(async () => {
        const tab = await this.api.tabs.get(sender.tab!.id!);
        if (!(await this.enabled()) || !isGitHub(tab.url)) throw new Error('Highlighting disabled or GitHub tab closed');
        await this.api.alarms.clear(IDLE_ALARM);
        await this.ensure();
      });
      return await this.api.runtime.sendMessage({ target: 'offscreen', type: 'parse', source });
    } catch { return { error: 'Shared WebGPU runtime unavailable' }; }
  }
}
