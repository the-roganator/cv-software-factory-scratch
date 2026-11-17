import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { PassLog, STORE_AWAY_MS } from '../../src/line/store-absence.ts';

/** A pass log on a clock the test moves, and the level and message of each line it logs. */
function passLog() {
  let at = 0;
  const lines: string[] = [];
  const say = (level: string) => (_: unknown, message: string) => lines.push(`${level}: ${message}`);
  const log = { info: say('info'), warn: say('warn'), error: say('error') } as unknown as Logger;
  const passes = new PassLog(log, () => new Date(at));
  return { passes, lines, after: (ms: number) => (at += ms) };
}

const refused = Object.assign(new Error('connect ECONNREFUSED 10.43.0.7:5432'), { code: 'ECONNREFUSED' });
const restarting = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

describe('a pass of the line', () => {
  it('warns while the store is away for a restart, and says when it is back', () => {
    const { passes, lines, after } = passLog();
    passes.passed();
    passes.failed(restarting);
    after(15_000);
    passes.failed(refused);
    after(15_000);
    passes.passed();
    passes.passed();
    expect(lines).toEqual([
      'warn: a pass of the line could not reach the store: the next pass tries again',
      'warn: a pass of the line could not reach the store: the next pass tries again',
      'info: the line reached the store again, after 30 s',
    ]);
  });

  it('fails loudly once the store has been away for a minute, and at every pass after', () => {
    const { passes, lines, after } = passLog();
    passes.failed(refused);
    after(STORE_AWAY_MS - 1);
    passes.failed(refused);
    after(1);
    passes.failed(refused);
    after(15_000);
    passes.failed(refused);
    expect(lines.map((line) => line.split(':')[0])).toEqual(['warn', 'warn', 'error', 'error']);
  });

  it('times a later absence from its own start', () => {
    const { passes, lines, after } = passLog();
    passes.failed(refused);
    after(50_000);
    passes.passed();
    after(50_000);
    passes.failed(refused);
    expect(lines.at(-1)?.startsWith('warn:')).toBe(true);
  });

  it('fails loudly at once for anything else', () => {
    const { passes, lines } = passLog();
    passes.failed(Object.assign(new Error('relation "events" does not exist'), { code: '42P01' }));
    passes.failed(new TypeError('cannot read properties of undefined'));
    expect(lines).toEqual(['error: a pass of the line failed', 'error: a pass of the line failed']);
  });
});
