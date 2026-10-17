import { discover, hasSyntax, LINE_SELECTOR, SOURCE_SELECTOR } from './dom';
import { Lexer, MAX_SOURCE } from './lexer';
import { isCurrent, makeRanges, Painter, snapshot, type Snapshot, type Ranges } from './render';
import type { Span, Status, Surface } from './types';

interface RecordState {
  id: number;
  surface: Surface;
  snapshots: Snapshot[];
  forced: boolean;
  state: string;
  revision: number;
}
const PAGE_BUDGET = 240_000;
const surfaceSize = (surface: Surface) => surface.groups.reduce((total, group) => total
  + group.reduce((n, line) => n + (line.element.textContent?.length ?? 0), 0)
  + Math.max(0, group.length - 1), 0);

export class Controller {
  private records = new Map<Element, RecordState>();
  private nextId = 1;
  private route = location.pathname + location.search;
  private generation = 0;
  private frame?: number;
  private observer?: MutationObserver;
  private scope?: Element;
  private stopped = false;
  private enabled = true;
  private queue: Promise<unknown> = Promise.resolve();
  private events = ['turbo:load', 'turbo:render', 'pjax:end', 'soft-nav:end'];
  constructor(private lexer = new Lexer(), private painter = new Painter()) {}

  start(enabled = true): void {
    this.enabled = enabled;
    for (const event of this.events) document.addEventListener(event, this.navigation);
    window.addEventListener('popstate', this.navigation);
    window.addEventListener('pageshow', this.navigation);
    window.addEventListener('pagehide', this.hide);
    // React's history navigation doesn't always emit Turbo events.
    window.navigation?.addEventListener('navigatesuccess', this.navigation);
    document.addEventListener('turbo:before-cache', this.beforeCache);
    document.addEventListener('turbo:before-render', this.beforeCache);
    this.attach();
    this.scan();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.cancelScheduled();
    this.clear();
    for (const event of this.events) document.removeEventListener(event, this.navigation);
    window.removeEventListener('popstate', this.navigation);
    window.removeEventListener('pageshow', this.navigation);
    window.removeEventListener('pagehide', this.hide);
    window.navigation?.removeEventListener('navigatesuccess', this.navigation);
    document.removeEventListener('turbo:before-cache', this.beforeCache);
    document.removeEventListener('turbo:before-render', this.beforeCache);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clear();
    if (enabled) { this.lexer.retry(); this.scan(); }
  }

  force(id: number): void {
    const record = [...this.records.values()].find(r => r.id === id);
    if (!record || !this.enabled || !record.surface.root.isConnected) return;
    const size = surfaceSize(record.surface);
    const used = [...this.records.values()].reduce((total, other) => total + (other !== record
      && ['Pending', 'Highlighted', 'Force highlighted'].includes(other.state)
      ? other.snapshots.reduce((n, s) => n + s.source.length, 0) : 0), 0);
    if (size > MAX_SOURCE || used + size > PAGE_BUDGET) {
      record.state = 'Skipped: size limit'; return;
    }
    record.forced = true;
    record.state = 'Pending';
    record.revision++;
    this.enqueue(record);
  }

  status(): Status {
    return {
      enabled: this.enabled,
      availability: !this.painter.supported ? 'CSS Highlight API unavailable'
        : this.lexer.failure || 'Shared WebGPU runtime; warmed on GitHub visits',
      files: [...this.records.values()].map(r => ({ id: r.id, label: r.surface.label, state: r.state, forced: r.forced })),
    };
  }

  private clear(): void {
    this.generation++;
    this.records.clear();
    this.painter.clear();
  }
  private beforeCache = (): void => { this.clear(); };
  private hide = (): void => { this.cancelScheduled(); this.observer?.disconnect(); this.clear(); };
  private navigation = (): void => {
    if (this.stopped) return;
    const route = location.pathname + location.search;
    if (route !== this.route) { this.clear(); this.route = route; }
    this.attach();
    this.schedule();
  };

  private attach(): void {
    const scope = document.querySelector('#repo-content-pjax-container') ?? document.querySelector('main') ?? document.body;
    if (this.scope === scope && this.scope.isConnected) {
      // pagehide disconnects observers, including BFCache restores.
      this.observer?.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
      return;
    }
    this.observer?.disconnect();
    this.scope = scope;
    this.observer = new MutationObserver(mutations => {
      if (mutations.some(m => {
        const element = m.target instanceof Element ? m.target : m.target.parentElement;
        if (element?.closest(`${LINE_SELECTOR}, ${SOURCE_SELECTOR}`)) return true;
        return m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].some(n =>
          n instanceof Element && (n.matches(`${SOURCE_SELECTOR}, ${LINE_SELECTOR}`) || n.querySelector(`${SOURCE_SELECTOR}, ${LINE_SELECTOR}`)));
      })) this.navigation();
    });
    this.observer.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  private schedule(): void {
    // Coalesce a burst before the next paint without postponing work when more
    // mutations arrive. Cached ranges can be restored in this same frame.
    if (this.stopped || !this.enabled || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.scan(); });
  }

  private cancelScheduled(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  // Public for deterministic integration testing; normal updates are batched.
  scan(): void {
    this.cancelScheduled();
    if (this.stopped || !this.enabled) return;
    if (location.pathname + location.search !== this.route) {
      this.clear(); this.route = location.pathname + location.search;
    }
    const surfaces = discover(this.scope ?? document);
    const roots = new Set(surfaces.map(s => s.root));
    for (const [root] of this.records) {
      if (!roots.has(root)) { this.painter.remove(root); this.records.delete(root); }
    }
    let budget = PAGE_BUDGET;
    for (const surface of surfaces) {
      let record = this.records.get(surface.root);
      const size = surfaceSize(surface);
      const native = !record?.forced && hasSyntax(surface);
      const tooLarge = size > MAX_SOURCE || (!native && size > budget);
      if (!native && !tooLarge) budget -= size;
      if (!record) {
        record = { id: this.nextId++, surface, snapshots: [], forced: false, state: 'Pending', revision: 0 };
        this.records.set(surface.root, record);
      }
      record.surface = surface;
      if (native || tooLarge || !this.painter.supported || this.lexer.failure) {
        record.revision++;
        record.snapshots = [];
        record.state = native ? 'GitHub highlighting' : tooLarge ? 'Skipped: size limit' : 'Unavailable';
        this.painter.remove(surface.root);
        continue;
      }
      const snapshots = surface.groups.map(snapshot);
      const unchanged = snapshots.length === record.snapshots.length && snapshots.every((s, i) => {
        const previous = record!.snapshots[i];
        return s.source === previous.source && s.pieces.length === previous.pieces.length
          && s.pieces.every((p, j) => p.node === previous.pieces[j].node && p.paint === previous.pieces[j].paint);
      });
      if (unchanged) continue;
      this.painter.remove(surface.root);
      record.snapshots = snapshots;
      record.revision++;
      record.state = 'Pending';
      this.enqueue(record);
    }
  }

  private enqueue(record: RecordState): void {
    // Force can target a file skipped because GitHub already colored it.
    if (!record.snapshots.length) record.snapshots = record.surface.groups.map(snapshot);
    const revision = record.revision, generation = this.generation;
    const current = () => !this.stopped && this.enabled && generation === this.generation
      && this.records.get(record.surface.root) === record && record.revision === revision
      && record.snapshots.every(isCurrent) && this.route === location.pathname + location.search;
    const cached = record.snapshots.map(value => this.lexer.cached(value.source));
    if (cached.every((spans): spans is Span[] => spans !== undefined) && current()) {
      try { this.paint(record, cached); }
      catch { record.state = 'Unavailable'; this.painter.remove(record.surface.root); }
      return;
    }
    this.queue = this.queue.then(async () => {
      if (!current()) return;
      if (record.snapshots.reduce((n, s) => n + s.source.length, 0) > MAX_SOURCE) {
        record.state = 'Skipped: size limit'; return;
      }
      if (!record.forced && hasSyntax(record.surface)) { record.state = 'GitHub highlighting'; return; }
      try {
        const results: Span[][] = [];
        for (const value of record.snapshots) {
          if (!current()) return;
          // Yield before the package's synchronous source preparation.
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!current()) return;
          const spans = await this.lexer.parse(value.source);
          if (!current()) return;
          results.push(spans);
        }
        if (!current()) return;
        if (!record.forced && hasSyntax(record.surface)) { record.state = 'GitHub highlighting'; return; }
        this.paint(record, results);
      } catch {
        if (current()) { record.state = 'Unavailable'; this.painter.remove(record.surface.root); }
      }
    }).catch(() => { /* A detached DOM must never interrupt GitHub. */ });
  }

  private paint(record: RecordState, results: Span[][]): void {
    const merged: Ranges = new Map();
    for (let i = 0; i < results.length; i++) {
      for (const [type, ranges] of makeRanges(record.snapshots[i], results[i])) {
        merged.set(type, [...(merged.get(type) ?? []), ...ranges]);
      }
    }
    this.painter.set(record.surface.root, merged);
    record.state = record.forced ? 'Force highlighted' : 'Highlighted';
  }
}
