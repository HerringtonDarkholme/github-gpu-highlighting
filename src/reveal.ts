import { animationSettings, DEFAULT_ANIMATION, type AnimationSettings } from './animation-settings';

// One CSS transition per code surface, including offscreen lines. Scrolling
// never starts or restarts a reveal; JavaScript only changes its endpoints.
const ATTRIBUTE = 'data-ugh-fade';
const PROGRESS = '--ugh-reveal';
const DURATION = '--ugh-fade-duration';
const COLOR = '--ugh-from-color';
const PROPERTIES = [PROGRESS, DURATION, COLOR];
type Styled = HTMLElement | SVGElement;
interface Saved { element: Styled; emptyStyle: boolean; values: [string, string, string][] }
interface Job {
  root: Element;
  element: Styled;
  from: number;
  target: number;
  started: number;
  duration: number;
  durationMs: number;
  saved: Saved[];
  timer?: ReturnType<typeof setTimeout>;
  finish: () => void;
}

export class Reveal {
  private settings: AnimationSettings = { ...DEFAULT_ANIMATION };
  configure(settings: AnimationSettings): void { this.settings = animationSettings(settings); }
  private active = new Map<Element, Job>();
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private scheme = matchMedia('(prefers-color-scheme: dark)');
  private theme?: MutationObserver;

  start(root: Element, lines: Element[], fresh = true): void {
    const previous = this.active.get(root);
    if (!fresh && (!previous || previous.element === root)) return;
    this.begin(root, lines, 1);
  }

  hide(root: Element, lines: Element[], done: () => void): void {
    this.begin(root, lines, 0, done);
  }

  private begin(root: Element, lines: Element[], target: number, done?: () => void): void {
    const previous = this.active.get(root);
    const durationMs = previous?.durationMs ?? this.settings.durationMs;
    const from = previous ? this.progress(previous) : target === 1 ? 0 : 1;
    this.cancel(root);
    if (!root.isConnected || !(root instanceof HTMLElement || root instanceof SVGElement)
      || !durationMs || this.reduced.matches || document.visibilityState === 'hidden'
      || typeof CSS.registerProperty !== 'function'
      || !CSS.supports('color', 'color-mix(in srgb, black, white)') || Math.abs(target - from) < 0.001) {
      done?.(); return;
    }

    // React may clone a root while its temporary styles are present. They are
    // extension-owned and must not outlive the transition on the new root.
    if (root.hasAttribute(ATTRIBUTE)) {
      for (const node of [root, ...root.querySelectorAll<Styled>('[style]')]) {
        for (const property of PROPERTIES) node.style.removeProperty(property);
        if (!node.style.length) node.removeAttribute('style');
      }
      root.removeAttribute(ATTRIBUTE);
    }

    // Read original foregrounds before writing styles. Native nested tokens
    // keep their individual colors when manually fading to/from GPU colors.
    const origins = new Map<Styled, string>([[root, getComputedStyle(root).color]]);
    for (const element of new Set(lines)) {
      const colors = new Map<Element, string>();
      for (const node of [element, ...element.querySelectorAll<Styled>('*')]) {
        const color = getComputedStyle(node).color;
        colors.set(node, color);
        if (color !== (node === element ? origins.get(root) : colors.get(node.parentElement!))) {
          origins.set(node as Styled, color);
        }
      }
    }
    const saved = [...origins].map(([element]) => ({
      element, emptyStyle: !element.hasAttribute('style'),
      values: PROPERTIES.map(property => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)] as [string, string, string]),
    }));
    for (const [element, color] of origins) element.style.setProperty(COLOR, color);
    const duration = durationMs * Math.abs(target - from);
    root.setAttribute(ATTRIBUTE, 'prepare');
    root.style.setProperty(PROGRESS, String(from));
    root.style.setProperty(DURATION, `${duration}ms`);
    // Establish the starting style once. CSS performs all interpolation;
    // there is no frame loop and no Web Animations API call.
    getComputedStyle(root).getPropertyValue(PROGRESS);
    root.setAttribute(ATTRIBUTE, 'active');
    root.style.setProperty(PROGRESS, String(target));
    getComputedStyle(root).getPropertyValue(PROGRESS);

    const job: Job = { root, element: root, from, target, started: performance.now(), duration, durationMs, saved, finish: () => {} };
    job.finish = () => {
      if (this.active.get(job.root) !== job) return;
      // Remove highlight ranges before restoring default progress after a
      // fade-out, otherwise their final color could flash for a frame.
      done?.();
      this.cancel(job.root);
    };
    root.addEventListener('transitionend', this.ended);
    this.active.set(root, job);
    job.timer = setTimeout(job.finish, duration + 80); // Hidden/detached roots may omit transitionend.
    this.watch();
  }

  private progress(job: Job): number {
    if (job.element.isConnected) {
      const value = Number(getComputedStyle(job.element).getPropertyValue(PROGRESS));
      if (Number.isFinite(value)) return value;
    }
    const elapsed = Math.min(1, Math.max(0, (performance.now() - job.started) / job.duration));
    return job.from + (job.target - job.from) * elapsed;
  }

  private ended = (event: Event): void => {
    if ((event as TransitionEvent).propertyName !== PROGRESS) return;
    for (const job of this.active.values()) if (event.target === job.element) { job.finish(); break; }
  };

  move(from: Element, to: Element): void {
    const job = this.active.get(from);
    if (!job) return;
    this.active.delete(from);
    job.root = to;
    this.active.set(to, job);
  }

  cancel(root: Element): void {
    const job = this.active.get(root);
    if (!job) return;
    this.active.delete(root);
    clearTimeout(job.timer);
    job.element.removeEventListener('transitionend', this.ended);
    // Changing duration to zero does not cancel an existing CSS transition.
    // Explicitly remove its property first, then restore the host's styles.
    job.element.setAttribute(ATTRIBUTE, 'prepare');
    getComputedStyle(job.element).transitionProperty;
    job.element.removeAttribute(ATTRIBUTE);
    for (const { element, values, emptyStyle } of job.saved) {
      element.getAttribute('style'); // Synchronize the inline CSS declaration before restoring it.
      for (const [property, value, priority] of values) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
      if (emptyStyle && !element.style.length) element.removeAttribute('style');
    }
    // Newly cloned descendants were not in the original style snapshot.
    const savedElements = new Set(job.saved.map(value => value.element));
    for (const element of job.element.querySelectorAll<Styled>('[style]')) {
      if (savedElements.has(element)) continue;
      for (const property of PROPERTIES) element.style.removeProperty(property);
      if (!element.style.length) element.removeAttribute('style');
    }
    getComputedStyle(job.element).getPropertyValue(PROGRESS);
    this.unwatch();
  }

  clear = (): void => {
    // Finish pending fade-outs too, so theme/accessibility changes cannot
    // leave disabled highlighting painted indefinitely.
    for (const job of [...this.active.values()]) job.finish();
  };

  private watch(): void {
    if (this.theme) return;
    this.theme = new MutationObserver(this.clear);
    this.theme.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-color-mode', 'data-light-theme', 'data-dark-theme'],
    });
    this.reduced.addEventListener('change', this.clear);
    this.scheme.addEventListener('change', this.clear);
  }
  private unwatch(): void {
    if (this.active.size) return;
    this.theme?.disconnect();
    this.theme = undefined;
    this.reduced.removeEventListener('change', this.clear);
    this.scheme.removeEventListener('change', this.clear);
  }
}
