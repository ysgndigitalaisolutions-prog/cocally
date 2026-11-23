import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAL_GAP, DialGap, gapOf } from '../dial-gap';

const GAP = { min: 3, max: 5 };

describe('dial spacing', () => {
  it('the second of two free lines waits 3-5 s after the first dial', () => {
    const g = new DialGap(() => 0.5); // 4 s
    expect(g.ready('c', 0, 0, GAP)).toBe(true);
    g.placed('c', 0, GAP);
    expect(g.ready('c', 1, 1000, GAP)).toBe(false);
    expect(g.ready('c', 1, 3999, GAP)).toBe(false);
    expect(g.ready('c', 1, 4000, GAP)).toBe(true);
  });

  it('a line that frees up waits 3-5 s before the next dial', () => {
    const g = new DialGap(() => 0); // 3 s
    g.ready('c', 0, 0, GAP);
    g.placed('c', 0, GAP);
    g.ready('c', 1, 3000, GAP);
    g.placed('c', 3000, GAP);
    expect(g.ready('c', 2, 60_000, GAP)).toBe(true); // both live; the cap, not the gap, holds it
    expect(g.ready('c', 1, 90_000, GAP)).toBe(false); // one hung up just now
    expect(g.ready('c', 1, 92_999, GAP)).toBe(false);
    expect(g.ready('c', 1, 93_000, GAP)).toBe(true);
  });

  it('waits fall between min and max', () => {
    for (const r of [0, 0.25, 0.999]) {
      const g = new DialGap(() => r);
      g.placed('c', 0, GAP);
      let t = 0;
      while (!g.ready('c', 1, t, GAP)) t += 100;
      expect(t).toBeGreaterThanOrEqual(3000);
      expect(t).toBeLessThanOrEqual(5000);
    }
  });

  it('campaigns are spaced separately', () => {
    const g = new DialGap(() => 0);
    g.placed('a', 0, GAP);
    expect(g.ready('b', 0, 100, GAP)).toBe(true);
    expect(g.ready('a', 1, 100, GAP)).toBe(false);
  });

  it('defaults to 3-5 s, and max 0 turns it off', () => {
    expect(gapOf({})).toEqual(DEFAULT_DIAL_GAP);
    expect(gapOf({ dialGapSeconds: { min: 8, max: 2 } })).toEqual({ min: 8, max: 8 });
    const g = new DialGap();
    const off = gapOf({ dialGapSeconds: { min: 0, max: 0 } });
    g.placed('c', 0, off);
    expect(g.ready('c', 1, 1, off)).toBe(true);
  });
});
