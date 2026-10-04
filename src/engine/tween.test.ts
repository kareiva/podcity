import { describe, expect, it } from 'vitest';
import { ease, Tweener } from './tween';

describe('Tweener', () => {
  it('interpolates on the given clock and resolves when done', async () => {
    const tw = new Tweener();
    let v = -1;
    let done = false;
    tw.tween({ duration: 2, ease: ease.linear, update: (k) => (v = k) }).then(() => (done = true));
    tw.update(1);
    expect(v).toBeCloseTo(0.5);
    tw.update(2);
    await Promise.resolve();
    expect(v).toBe(1);
    expect(done).toBe(true);
    expect(tw.size).toBe(0);
  });

  it('respects delay', () => {
    const tw = new Tweener();
    let v = -1;
    tw.tween({ duration: 1, delay: 1, ease: ease.linear, update: (k) => (v = k) });
    tw.update(0.5);
    expect(v).toBe(-1);
    tw.update(1.5);
    expect(v).toBeCloseTo(0.5);
  });
});

describe('Tweener modes', () => {
  it('completes immediately when instant', async () => {
    const tw = new Tweener();
    tw.instant = true;
    let v = -1;
    await tw.tween({ duration: 5, delay: 3, update: (k) => (v = k) });
    expect(v).toBe(1);
    expect(tw.size).toBe(0);
  });

  it('clear drops pending tweens', () => {
    const tw = new Tweener();
    tw.tween({ duration: 1, update: () => {} });
    tw.clear();
    expect(tw.size).toBe(0);
  });
});
