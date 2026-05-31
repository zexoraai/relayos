import { describe, it, expect } from 'vitest';
import { effectiveLoadWeight } from '../../src/packerAuth/assigner';

/**
 * Pin the rating-aware effective weight curve.
 *
 * The algorithm:
 *   effective = nominal * (rating ?? 4) / 4
 *   floor     = 0.25 * nominal
 *   result    = max(effective, floor)
 *
 * Test cases below are the corner cases an operator might hit. If
 * any of these breaks, the assigner's distribution shifts in a
 * non-trivial way and this test is the early warning.
 */
describe('effectiveLoadWeight', () => {
  it('treats null rating as neutral 4.0 (effective == nominal)', () => {
    expect(effectiveLoadWeight(2, null)).toBe(2);
    expect(effectiveLoadWeight(5, undefined)).toBe(5);
  });

  it('treats rating === 4 as neutral (effective == nominal)', () => {
    expect(effectiveLoadWeight(2, 4)).toBe(2);
    expect(effectiveLoadWeight(10, 4)).toBe(10);
  });

  it('scales above neutral: rating 5 → 1.25x nominal', () => {
    expect(effectiveLoadWeight(4, 5)).toBeCloseTo(5);
    expect(effectiveLoadWeight(8, 5)).toBeCloseTo(10);
  });

  it('scales below neutral but above floor: rating 2 → 0.5x nominal', () => {
    expect(effectiveLoadWeight(4, 2)).toBeCloseTo(2);
    expect(effectiveLoadWeight(8, 2)).toBeCloseTo(4);
  });

  it('clamps to a 25%% floor for very low ratings', () => {
    // rating 1.0 would naively give 0.25x — equal to floor, no clamp needed
    expect(effectiveLoadWeight(8, 1)).toBeCloseTo(2);   // 8 * 0.25 = 2
    // rating 0.5 would give 0.125x — clamped up to 0.25x = 2
    expect(effectiveLoadWeight(8, 0.5)).toBeCloseTo(2); // floor
    // rating 0 (edge case) — clamped to floor
    expect(effectiveLoadWeight(8, 0)).toBeCloseTo(2);
  });

  it('returns 0 when load_weight is 0 (paused / zero-weighted packers stay zero)', () => {
    expect(effectiveLoadWeight(0, 5)).toBe(0);
    expect(effectiveLoadWeight(0, null)).toBe(0);
  });

  it('clamps rating to [0, 5] for defensive bounds', () => {
    // Anyone passing in rating > 5 (shouldn't happen but be defensive)
    // gets the same boost as rating 5 — no super-stars.
    expect(effectiveLoadWeight(4, 99)).toBeCloseTo(5);
    // Negative rating treated as 0 → floor.
    expect(effectiveLoadWeight(8, -1)).toBeCloseTo(2);
  });
});
