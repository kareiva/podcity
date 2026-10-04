/** Simulation clock: real time scaled by a speed factor, pausable. */
export class SimClock {
  now = 0;
  speed = 1;
  paused = false;

  /** Advance by real seconds; returns scaled simulation delta. */
  tick(realDt: number): number {
    if (this.paused) return 0;
    // Clamp so a backgrounded tab does not replay minutes of events at once.
    const dt = Math.min(realDt, 0.1) * this.speed;
    this.now += dt;
    return dt;
  }
}
