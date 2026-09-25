/**
 * Clock abstraction so the whole engine can run against a fake clock in the simulator and tests.
 * Timers fire in chronological order; the fake clock advances time by firing everything due.
 */

export type TimerHandle = number;

export interface Clock {
  /** epoch ms */
  now(): number;
  /** Fires `cb` once when the clock reaches `at` (epoch ms). Fires immediately-ish if `at` is in the past. */
  setTimer(at: number, cb: () => void): TimerHandle;
  /** Fires `cb` every `intervalMs`, first time after `intervalMs`. */
  setInterval(intervalMs: number, cb: () => void): TimerHandle;
  clear(handle: TimerHandle): void;
}

const MAX_TIMEOUT = 2_147_483_647;

export class RealClock implements Clock {
  private next = 1;
  private timers = new Map<TimerHandle, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimer(at: number, cb: () => void): TimerHandle {
    const handle = this.next++;
    const arm = () => {
      const delay = Math.max(0, at - Date.now());
      if (delay > MAX_TIMEOUT) {
        this.timers.set(handle, setTimeout(arm, MAX_TIMEOUT));
        return;
      }
      this.timers.set(
        handle,
        setTimeout(() => {
          // Guard against the system clock jumping or the event loop lagging: re-arm if we are early.
          if (Date.now() < at - 5) {
            arm();
            return;
          }
          this.timers.delete(handle);
          cb();
        }, delay),
      );
    };
    arm();
    return handle;
  }

  setInterval(intervalMs: number, cb: () => void): TimerHandle {
    const handle = this.next++;
    this.timers.set(handle, setInterval(cb, intervalMs));
    return handle;
  }

  clear(handle: TimerHandle): void {
    const t = this.timers.get(handle);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.timers.delete(handle);
    }
  }
}

interface SimTimer {
  handle: TimerHandle;
  at: number;
  cb: () => void;
  interval?: number;
}

export class SimClock implements Clock {
  private current: number;
  private next = 1;
  private timers: SimTimer[] = [];

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimer(at: number, cb: () => void): TimerHandle {
    const handle = this.next++;
    this.timers.push({ handle, at: Math.max(at, this.current), cb });
    return handle;
  }

  setInterval(intervalMs: number, cb: () => void): TimerHandle {
    const handle = this.next++;
    this.timers.push({ handle, at: this.current + intervalMs, cb, interval: intervalMs });
    return handle;
  }

  clear(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  }

  /** Jumps to an absolute time, firing every timer due on the way, in order. */
  advanceTo(targetMs: number): void {
    if (targetMs < this.current) throw new Error('SimClock cannot go backwards');
    for (;;) {
      const due = this.timers.filter((t) => t.at <= targetMs).sort((a, b) => a.at - b.at || a.handle - b.handle)[0];
      if (!due) break;
      this.current = Math.max(this.current, due.at);
      if (due.interval) {
        due.at += due.interval;
      } else {
        this.timers = this.timers.filter((t) => t !== due);
      }
      due.cb();
    }
    this.current = targetMs;
  }

  advance(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  /** Sets the time without firing anything (used to position the simulator before a scenario). */
  jumpTo(ms: number): void {
    this.current = ms;
  }
}
