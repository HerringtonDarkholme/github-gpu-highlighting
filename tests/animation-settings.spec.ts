import { test, expect } from '@playwright/test';
import { animationSettings } from '../src/animation-settings';

test('animation preferences default safely and bound stored values', () => {
  expect(animationSettings(undefined)).toEqual({ durationMs: 420 });
  expect(animationSettings({ durationMs: 0 })).toEqual({ durationMs: 0 });
  expect(animationSettings({ durationMs: 800 })).toEqual({ durationMs: 800 });
  expect(animationSettings({ durationMs: -1 })).toEqual({ durationMs: 0 });
  expect(animationSettings({ durationMs: Infinity })).toEqual({ durationMs: 420 });
  expect(animationSettings({ durationMs: 9000 })).toEqual({ durationMs: 9000 });
  expect(animationSettings({ durationMs: 270, staggerMs: 1000 })).toEqual({ durationMs: 270 });
});
