import { describe, it, expect } from 'vitest';
import { formatDigestBody } from '../../src/packerAuth/digestWorker';

/**
 * Pin the digest copy. The wording is part of the product surface —
 * if it shifts unintentionally the operator team will hear about it
 * before we will, so let's catch it in CI.
 */
describe('formatDigestBody', () => {
  it('formats the happy path with delta up', () => {
    const body = formatDigestBody('Sam', {
      hasNewRatings: true,
      thisWeekCount: 4,
      thisWeekOverall: 4.25,
      lastWeekOverall: 4.0,
      delta: 0.25,
      worstCriterion: { name: 'Speed', score: 3.5 },
    });
    expect(body).toContain('Hi Sam');
    expect(body).toContain('★ Overall this week: 4.25 / 5');
    expect(body).toContain('(4 ratings)');
    expect(body).toContain('Up 0.25 from last week');
    expect(body).toContain('Lowest score this week: Speed (3.50');
    expect(body).toContain('untick "Weekly digest"');
  });

  it('reports a flat week without sounding alarmed', () => {
    const body = formatDigestBody('Pat', {
      hasNewRatings: true,
      thisWeekCount: 1,
      thisWeekOverall: 4.0,
      lastWeekOverall: 4.0,
      delta: 0,
      worstCriterion: { name: 'Reliability', score: 4.0 },
    });
    expect(body).toContain('(1 rating)');
    expect(body).toContain('Flat versus last week');
  });

  it('flags a drop with the absolute delta', () => {
    const body = formatDigestBody('Lee', {
      hasNewRatings: true,
      thisWeekCount: 2,
      thisWeekOverall: 3.5,
      lastWeekOverall: 4.5,
      delta: -1.0,
      worstCriterion: null,
    });
    expect(body).toContain('Down 1.00 from last week');
    expect(body).not.toContain('Lowest score this week');
  });

  it('uses a friendly first-week message when no prior week exists', () => {
    const body = formatDigestBody('Chris', {
      hasNewRatings: true,
      thisWeekCount: 3,
      thisWeekOverall: 4.5,
      lastWeekOverall: null,
      delta: null,
      worstCriterion: null,
    });
    expect(body).toContain('First week with ratings');
  });
});
