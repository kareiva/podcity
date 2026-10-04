import type { EventBus } from './bus';
import type { Step } from './scenario';
import { applyEvent, createState, type PodmanState } from './state';

/** Plays steps one at a time against the state, emitting events on the bus. */
export class Simulator {
  state: PodmanState = createState();
  private step = -1;
  private cursor = 0;
  private startedAt = 0;

  constructor(
    private readonly bus: EventBus,
    readonly steps: readonly Step[],
  ) {}

  get current(): number {
    return this.step;
  }

  /** All events of the current step have been emitted. */
  get stepDone(): boolean {
    const s = this.steps[this.step];
    return !s || this.cursor >= s.events.length;
  }

  reset(): void {
    this.state = createState();
    this.step = -1;
    this.cursor = 0;
  }

  /** Emit every event of steps [0, upTo) immediately. */
  fastForward(upTo: number): void {
    for (let i = 0; i < upTo; i++) for (const { event } of this.steps[i]?.events ?? []) this.emit(event);
    this.step = upTo - 1;
    this.cursor = Number.POSITIVE_INFINITY;
  }

  /** Start playing step `i` with simulation time `now` as its zero. */
  begin(i: number, now: number): void {
    this.step = i;
    this.cursor = 0;
    this.startedAt = now;
  }

  /** Emit events of the current step that are due at simulation time `now`. */
  update(now: number): void {
    const events = this.steps[this.step]?.events ?? [];
    while (this.cursor < events.length) {
      const next = events[this.cursor]!;
      if (next.at > now - this.startedAt) break;
      this.cursor++;
      this.emit(next.event);
    }
  }

  private emit(event: Parameters<typeof applyEvent>[1]): void {
    applyEvent(this.state, event);
    this.bus.emit(event);
  }
}
