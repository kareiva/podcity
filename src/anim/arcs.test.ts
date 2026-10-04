import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { arcCurve } from './arcs';

describe('arcCurve', () => {
  it('starts and ends at the endpoints and rises above both', () => {
    const a = new Vector3(0, 2, 0);
    const b = new Vector3(40, 6, 0);
    const c = arcCurve(a, b);
    expect(c.getPoint(0).equals(a)).toBe(true);
    expect(c.getPoint(1).equals(b)).toBe(true);
    expect(c.getPoint(0.5).y).toBeGreaterThan(6);
  });
});
