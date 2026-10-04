export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
} satisfies Record<string, Ease>;

export interface TweenOptions {
  duration: number; // simulation seconds
  delay?: number;
  ease?: Ease;
  update: (k: number) => void; // k is eased progress 0..1
}

interface ActiveTween {
  start: number;
  duration: number;
  ease: Ease;
  update: (k: number) => void;
  resolve: () => void;
}

/**
 * Tweens driven by the simulation clock, so pausing and speed changes apply
 * to all animation uniformly. `tween()` returns a promise so choreographies
 * can be written as plain async sequences.
 */
export class Tweener {
  private active: ActiveTween[] = [];
  private now = 0;
  /** Multiplier for all durations, e.g. near zero for prefers-reduced-motion. */
  durationScale = 1;
  /** Complete every new tween immediately (used to fast-forward replays). */
  instant = false;

  tween(opts: TweenOptions): Promise<void> {
    if (this.instant) {
      opts.update((opts.ease ?? ease.inOutCubic)(1));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.active.push({
        start: this.now + (opts.delay ?? 0) * this.durationScale,
        duration: Math.max(opts.duration * this.durationScale, 1e-6),
        ease: opts.ease ?? ease.inOutCubic,
        update: opts.update,
        resolve,
      });
    });
  }

  wait(seconds: number): Promise<void> {
    return this.tween({ duration: seconds, update: () => {} });
  }

  /** Drop all running tweens without resolving them; their choreographies stop. */
  clear(): void {
    this.active = [];
  }

  update(now: number): void {
    this.now = now;
    const still: ActiveTween[] = [];
    for (const t of this.active) {
      if (now < t.start) {
        still.push(t);
        continue;
      }
      const p = Math.min((now - t.start) / t.duration, 1);
      t.update(t.ease(p));
      if (p >= 1) t.resolve();
      else still.push(t);
    }
    this.active = still;
  }

  get size(): number {
    return this.active.length;
  }
}
