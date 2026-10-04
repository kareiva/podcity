import { describe, expect, it } from 'vitest';
import { CITY_RADIUS, districts, type Pad } from './layout';

const OUTSIDE = new Set(['seaport', 'hostLand', 'freight', 'businessCenter']);

const farthestCorner = (p: Pad) => Math.hypot(Math.abs(p.x) + p.w / 2, Math.abs(p.z) + p.d / 2);
const nearestPoint = (p: Pad) => Math.hypot(Math.max(Math.abs(p.x) - p.w / 2, 0), Math.max(Math.abs(p.z) - p.d / 2, 0));
const overlaps = (a: Pad, b: Pad) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

describe('city layout', () => {
  const inside = Object.entries(districts).filter(([id]) => !OUTSIDE.has(id));

  it('keeps inner districts within the wall', () => {
    for (const [id, pad] of inside) expect(farthestCorner(pad), id).toBeLessThan(CITY_RADIUS);
  });

  it('has no overlapping inner districts', () => {
    for (const [a, pa] of inside)
      for (const [b, pb] of inside) if (a < b) expect(overlaps(pa, pb), `${a}/${b}`).toBe(false);
  });

  it('places the systemd Business Center outside the wall', () => {
    expect(nearestPoint(districts.businessCenter)).toBeGreaterThan(CITY_RADIUS);
  });

  it('places the Demo Shopping Center next to the wall', () => {
    expect(farthestCorner(districts.shoppingCenter)).toBeGreaterThan(CITY_RADIUS - 10);
  });
});
