import type { EventWriter } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { SPEND } from '../../../../policy/spend.ts';
import { Spend } from '../../src/gateway/spend.ts';

const refused = Object.assign(new Error('connect ECONNREFUSED 10.43.0.7:5432'), { code: 'ECONNREFUSED' });

/** A spend count on a clock the test moves and a store that answers as the test says, and each line it logs. */
function counting() {
  let at = Date.UTC(2026, 0, 15, 12);
  let answer: () => Promise<unknown> = async () => [{ day: 0, month: 0 }];
  const lines: string[] = [];
  const say = (level: string) => (_: unknown, message: string) => lines.push(`${level}: ${message}`);
  const spend = new Spend({
    sql: (() => answer()) as unknown as Sql,
    events: {} as EventWriter,
    profile: 'local',
    policy: SPEND.local,
    log: { info: say('info'), warn: say('warn'), error: say('error') } as unknown as Logger,
    clock: () => new Date(at),
  });
  return {
    spend,
    lines,
    after: (ms: number) => (at += ms),
    store: (next: () => Promise<unknown>) => (answer = next),
  };
}

describe("the gateway's spend count while the store is away", () => {
  it('warns when the store refuses a connection, and says when it reached it again', async () => {
    const { spend, lines, after, store } = counting();
    await spend.reconcile();
    store(() => Promise.reject(refused));
    await spend.reconcile();
    after(7_000);
    store(async () => [{ day: 0, month: 0 }]);
    await spend.reconcile();
    await spend.reconcile();
    expect(lines).toEqual([
      'warn: could not update the line on spend caps, as the store is away: the next call or tick tries again',
      'info: the spend count reached the store again, after 7 s',
    ]);
  });

  it('fails loudly once the store has been away for a minute', async () => {
    const { spend, lines, after, store } = counting();
    store(() => Promise.reject(refused));
    await spend.reconcile();
    after(60_000);
    await spend.reconcile();
    expect(lines).toEqual([
      'warn: could not update the line on spend caps, as the store is away: the next call or tick tries again',
      'error: could not update the line on spend caps: the store has been away for over a minute',
    ]);
  });

  it('fails loudly at once for anything else', async () => {
    const { spend, lines, store } = counting();
    store(() => Promise.reject(Object.assign(new Error('relation "model_calls" does not exist'), { code: '42P01' })));
    await spend.reconcile();
    expect(lines).toEqual(['error: could not update the line on spend caps']);
  });
});
