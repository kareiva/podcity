import type { Director } from './anim/director';
import type { SimClock } from './engine/clock';
import type { Tweener } from './engine/tween';
import type { Simulator } from './sim/simulator';

/** Pause between steps when autoplaying, in simulation seconds. */
const STEP_PAUSE = 2;
/** With loop on: how long the last step keeps running before the city fades, in simulation seconds. */
const LOOP_PAUSE = 15;
/** Fade-out of all created objects before the loop starts over, in simulation seconds. */
const LOOP_FADE = 2;

/**
 * Plays the simulation step by step. Any step can be replayed on its own:
 * the scene is reset, earlier steps are applied instantly, then the chosen
 * step plays at normal speed.
 */
export class Player {
  autoplay = true;
  /** After the last step, fade everything out and start again from step 1 (needs autoplay). */
  loop = false;
  private seeking = false;
  private doneAt: number | null = null;
  private listeners = new Set<() => void>();
  private stepListeners = new Set<(i: number) => void>();

  constructor(
    private readonly sim: Simulator,
    private readonly director: Director,
    private readonly tw: Tweener,
    private readonly clock: SimClock,
  ) {}

  get steps() {
    return this.sim.steps;
  }

  get current(): number {
    return this.sim.current;
  }

  /** Current step has emitted all events and its animations have finished. */
  get stepFinished(): boolean {
    return this.doneAt !== null;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** Called as step `i` starts playing (autoplay, Next, replay or loop), after any fast-forward. */
  onStep(fn: (i: number) => void): void {
    this.stepListeners.add(fn);
  }

  /** Earlier steps are being applied instantly; their events are not part of the step being played. */
  get fastForwarding(): boolean {
    return this.seeking;
  }

  async goTo(i: number): Promise<void> {
    if (this.seeking) return;
    this.seeking = true;
    this.doneAt = null;
    this.director.reset();
    this.sim.reset();
    this.tw.instant = true;
    this.sim.fastForward(i);
    await this.director.idle();
    this.tw.instant = false;
    this.stepListeners.forEach((fn) => fn(i));
    this.sim.begin(i, this.clock.now);
    this.seeking = false;
    this.notify();
  }

  /** Called every frame with the simulation time. */
  update(now: number): void {
    if (this.seeking) return;
    this.sim.update(now);
    if (!this.sim.stepDone || !this.director.isIdle) return;
    if (this.doneAt === null) {
      this.doneAt = now;
      this.notify();
    }
    const next = this.sim.current + 1;
    if (this.autoplay && next < this.steps.length && now - this.doneAt >= STEP_PAUSE) {
      this.doneAt = null;
      this.stepListeners.forEach((fn) => fn(next));
      this.sim.begin(next, now);
      this.notify();
    } else if (this.autoplay && this.loop && next >= this.steps.length && now - this.doneAt >= LOOP_PAUSE) {
      void this.restart();
    }
  }

  /** Fade out every created object, then replay from step 1. */
  private async restart(): Promise<void> {
    this.seeking = true;
    await this.director.fadeOut(LOOP_FADE);
    this.seeking = false;
    await this.goTo(0);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}
