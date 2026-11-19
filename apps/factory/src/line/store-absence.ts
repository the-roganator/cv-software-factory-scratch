import { storeAway } from '@software-factory/store';
import type { Logger } from 'pino';

/**
 * How long the store may be away before a pass that cannot reach it is a fault: a minute. Patching Postgres restarts
 * its StatefulSet, and the store is back within seconds; a minute is several times that, and four passes at the line's
 * fifteen seconds. A store away for longer is a fault, logged as an error at every pass, as any other failure is.
 */
export const STORE_AWAY_MS = 60_000;

/**
 * Says how each pass of the line ended: a pass that could not reach the store, while it has been away less than
 * `STORE_AWAY_MS`, as a warning, and the pass that reaches it again with how long it was away; any other failure, and
 * every one once the store has been away for longer, as an error.
 */
export class PassLog {
  /** When the first pass of the store's absence failed, while it is away. */
  #awaySince: number | null = null;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(log: Logger, now: () => Date) {
    this.#log = log;
    this.#now = now;
  }

  passed(): void {
    if (this.#awaySince === null) return;
    const seconds = Math.round((this.#now().getTime() - this.#awaySince) / 1000);
    this.#awaySince = null;
    this.#log.info({ awaySeconds: seconds }, `the line reached the store again, after ${seconds} s`);
  }

  failed(error: unknown): void {
    if (!storeAway(error)) {
      this.#log.error({ err: error }, 'a pass of the line failed');
      return;
    }
    const now = this.#now().getTime();
    this.#awaySince ??= now;
    const away = now - this.#awaySince;
    if (away < STORE_AWAY_MS)
      this.#log.warn(
        { err: error, awayMs: away },
        'a pass of the line could not reach the store: the next pass tries again',
      );
    else
      this.#log.error(
        { err: error, awayMs: away },
        'a pass of the line failed: the store has been away for over a minute',
      );
  }
}
