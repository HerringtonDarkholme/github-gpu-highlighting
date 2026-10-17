export interface AnimationSettings { durationMs: number }
export const DEFAULT_ANIMATION: Readonly<AnimationSettings> = { durationMs: 420 };

export function animationSettings(value: unknown): AnimationSettings {
  const settings = value && typeof value === 'object' ? value as Partial<AnimationSettings> : {};
  // Leave room for cleanup within the browser's signed 32-bit timer limit.
  const bounded = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value)
    ? Math.min(2_147_483_000, Math.max(0, Math.round(value))) : fallback;
  return {
    durationMs: bounded(settings.durationMs, DEFAULT_ANIMATION.durationMs),
  };
}
