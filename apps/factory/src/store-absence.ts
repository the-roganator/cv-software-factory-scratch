import { storeAway } from '@software-factory/store';
import type { Logger } from 'pino';

/**
 * How long the store may be away before a pass that cannot reach it is a fault: a minute. Patching Postgres restarts
 * its StatefulSet, and the store is back within seconds; a minute is several times that, and four passes at a worker's
 * fifteen seconds. A store away for longer is a fault, logged as an error at every pass, as any other failure is.
 */
export const STORE_AWAY_MS = 60_000;

/** What a worker's passes are called in its log. */
export interface PassWords {
  /** A pass that could not reach the store, while it has been away less than `STORE_AWAY_MS`: a warning. */
  away: string;
  /** A pass that could not reach it once it has been away for longer: an error. */
  stillAway: string;
  /** A pass that failed in any other way: an error. */
  failed: string;
  /** The pass that reached the store again, after so many seconds: an info line. */
  back(seconds: number): string;
}

/**
 * Says how each pass of a worker at the store ended: a pass that could not reach the store, while it has been away
 * less than `STORE_AWAY_MS`, as a warning, and the pass that reaches it again with how long it was away; any other
 * failure, and every one once the store has been away for longer, as an error. The worker must go on making passes
 * while the store is away, as only a pass that reaches it ends the absence.
 */
export class PassLog {
  /** When the first pass of the store's absence failed, while it is away. */
  #awaySince: number | null = null;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #words: PassWords;

  constructor(log: Logger, now: () => Date, words: PassWords) {
    this.#log = log;
    this.#now = now;
    this.#words = words;
  }

  passed(): void {
    if (this.#awaySince === null) return;
    const seconds = Math.round((this.#now().getTime() - this.#awaySince) / 1000);
    this.#awaySince = null;
    this.#log.info({ awaySeconds: seconds }, this.#words.back(seconds));
  }

  /** A pass failed, with `error`; `about` is what the worker's line says of the pass besides. */
  failed(error: unknown, about: Record<string, unknown> = {}): void {
    if (!storeAway(error)) {
      this.#log.error({ ...about, err: error }, this.#words.failed);
      return;
    }
    const now = this.#now().getTime();
    this.#awaySince ??= now;
    const away = now - this.#awaySince;
    if (away < STORE_AWAY_MS) this.#log.warn({ ...about, err: error, awayMs: away }, this.#words.away);
    else this.#log.error({ ...about, err: error, awayMs: away }, this.#words.stillAway);
  }
}
