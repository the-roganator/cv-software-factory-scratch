/**
 * The autonomy level Martin set in the console, as the GitHub worker reads it before it adds a move to the merge queue:
 * the one table (`ENQUEUES`, `policy/line.ts`) says what each level queues, and the worker reads it as the line does.
 *
 * The level is read from the store, as the line reads it: the latest `controls.changed` one of Martin's roles appended
 * (`latestControls`), turned into the controls in force (`controlsInForce`). The worker connects as `factory_github`,
 * which may read those events and nothing else (0053_github-reads-the-level.sql). It reads the level afresh each time
 * it is about to add a move, so a level Martin changes holds from the next pass of the queue, with nothing restarted.
 *
 * A level it cannot read is Supervised: a worker with no store (`PGHOST` unset), or one whose read failed, queues no
 * move. Each is said once, and the read's return is said once too.
 */
import type { Autonomy } from '@software-factory/events';
import { latestControls } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { controlsInForce, ENQUEUES } from '../../../../policy/line.ts';
import type { Rule } from '../../../../policy/review-verdict.ts';

/** The level in force now, or Supervised when it cannot be read. */
export type LevelReader = () => Promise<Autonomy>;

/** The level from the store, read each time it is asked for; Supervised, said once, while a read fails. */
export function storeLevel(sql: Sql, log: Pick<Logger, 'info' | 'warn'>): LevelReader {
  let failing = false;
  return async () => {
    try {
      const { autonomy } = controlsInForce(await latestControls(sql));
      if (failing) log.info({ autonomy }, 'reading the autonomy level again');
      failing = false;
      return autonomy;
    } catch (error) {
      if (!failing) log.warn({ err: error }, 'could not read the autonomy level: queuing as at Supervised');
      failing = true;
      return 'supervised';
    }
  };
}

/** A worker with no store: always Supervised, and it says so when it starts. */
export function noLevel(log: Pick<Logger, 'warn'>): LevelReader {
  log.warn('No store (PGHOST): the worker cannot read the autonomy level, and queues no move, as at Supervised.');
  return async () => 'supervised';
}

/** Whether the level lets the worker add a pull request the gate passed by a rule, by `ENQUEUES`. */
export const levelAllows = (autonomy: Autonomy, rule: Rule): boolean => ENQUEUES[autonomy].includes(rule);
