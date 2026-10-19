import { dateInZone, type CalendarDate } from './dates';

/** All "now" reads go through a Clock so the seeded scenario can pin business time. */
export interface Clock {
  now(): Date;
  nowIso(): string;
  today(timeZone: string): CalendarDate;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return this.now().toISOString();
  }
  today(timeZone: string): CalendarDate {
    return dateInZone(this.now(), timeZone);
  }
}

/**
 * Starts at a fixed business instant and then advances with real elapsed time, so the
 * scenario always opens at "WD+2, 9:00am" while timestamps still move forward.
 */
export class AnchoredClock implements Clock {
  private readonly anchorMs: number;
  private readonly startedMs: number;

  constructor(anchorIso: string, private readonly realNow: () => number = () => Date.now()) {
    this.anchorMs = Date.parse(anchorIso);
    if (Number.isNaN(this.anchorMs)) throw new TypeError(`invalid anchor ${anchorIso}`);
    this.startedMs = realNow();
  }
  now(): Date {
    return new Date(this.anchorMs + (this.realNow() - this.startedMs));
  }
  nowIso(): string {
    return this.now().toISOString();
  }
  today(timeZone: string): CalendarDate {
    return dateInZone(this.now(), timeZone);
  }
}

/** Fully controllable clock for tests. */
export class ManualClock implements Clock {
  private ms: number;
  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
  }
  now(): Date {
    return new Date(this.ms);
  }
  nowIso(): string {
    return this.now().toISOString();
  }
  today(timeZone: string): CalendarDate {
    return dateInZone(this.now(), timeZone);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}
