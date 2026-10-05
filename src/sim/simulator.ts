import type { EventBus } from './bus';
import type { SimEvent } from './events';
import type { Step } from './scenario';
import { applyEvent, createState, type PodmanState } from './state';

/** Back-off before `--restart=always` starts an exited container again, in simulation seconds. */
export const RESTART_DELAY = 1;

/** Plays steps one at a time against the state, emitting events on the bus. */
export class Simulator {
  state: PodmanState = createState();
  private step = -1;
  private cursor = 0;
  private startedAt = 0;
  private now = 0;
  /** Background events podman itself causes (workload exits, restart policy), at absolute sim time. */
  private timers: { at: number; event: SimEvent }[] = [];

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
    this.timers = [];
  }

  /**
   * Emit every event of steps [0, upTo) immediately. Background timers are
   * not run while fast-forwarding; `begin` re-arms them from the end state.
   */
  fastForward(upTo: number): void {
    for (let i = 0; i < upTo; i++) for (const { event } of this.steps[i]?.events ?? []) this.emit(event);
    this.step = upTo - 1;
    this.cursor = Number.POSITIVE_INFINITY;
    this.timers = [];
  }

  /** Start playing step `i` with simulation time `now` as its zero. */
  begin(i: number, now: number): void {
    this.step = i;
    this.cursor = 0;
    this.startedAt = now;
    this.now = now;
    // Re-arm the restart loop of containers carried over from earlier steps.
    this.timers = [];
    for (const c of this.state.containers.values()) {
      if (c.status === 'running' && c.runFor !== undefined) this.schedule(c.runFor, { type: 'container.exit', id: c.id, code: 0 });
      if (c.status === 'exited' && c.restartPolicy === 'always') this.schedule(RESTART_DELAY, { type: 'container.start', id: c.id, restart: true });
    }
  }

  /**
   * Emit events of the current step that are due at simulation time `now`,
   * then background events (restarts) that are due. An infinite `now` only
   * drains the step: the restart loop never ends.
   */
  update(now: number): void {
    const events = this.steps[this.step]?.events ?? [];
    while (this.cursor < events.length) {
      const next = events[this.cursor]!;
      if (next.at > now - this.startedAt) break;
      this.cursor++;
      this.now = this.startedAt + next.at;
      this.emit(next.event);
    }
    if (!Number.isFinite(now)) return;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (!due || due.at > now) break;
      this.timers.shift();
      this.now = due.at;
      this.emit(due.event);
    }
    this.now = Math.max(this.now, now);
  }

  private schedule(delay: number, event: SimEvent): void {
    this.timers.push({ at: this.now + delay, event });
  }

  private emit(event: SimEvent): void {
    applyEvent(this.state, event);
    this.bus.emit(event);
    // Podman's own follow-ups: the workload finishing, and the restart policy.
    const id = 'id' in event ? event.id : undefined;
    const c = id ? this.state.containers.get(id) : undefined;
    if (event.type === 'container.start' && c?.runFor !== undefined) this.schedule(c.runFor, { type: 'container.exit', id: c.id, code: 0 });
    if (event.type === 'container.exit' && c?.restartPolicy === 'always') this.schedule(RESTART_DELAY, { type: 'container.start', id: c.id, restart: true });
    if (event.type === 'container.remove') this.timers = this.timers.filter((t) => !('id' in t.event) || t.event.id !== event.id);
  }
}
