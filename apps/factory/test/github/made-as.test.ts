import { describe, expect, it } from 'vitest';
import { type MadeAs, madeAsOf, withMadeAs } from '../../src/github/made-as.ts';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const MADE: MadeAs = {
  at: '2026-11-20T05:00:00.000Z',
  asked: [
    { image: 'gcr.io/distroless/nodejs24-debian13', tag: 'nonroot', digest: digest('4') },
    { image: 'localhost:5000/node', tag: '24.22.2-alpine3.24', digest: digest('3') },
  ],
};

describe('how the pin step made a move, as its commit says it (C-1)', () => {
  it('is said last in the message and read back whole, an image named with a port and all', () => {
    const message = withMadeAs('fix(deps): move node to 24.22.2\n\nThe pin step moved Node.', MADE);
    expect(message).toBe(
      [
        'fix(deps): move node to 24.22.2',
        '',
        'The pin step moved Node.',
        '',
        'Pins-made-at: 2026-11-20T05:00:00.000Z',
        `Pins-asked: gcr.io/distroless/nodejs24-debian13:nonroot@${digest('4')}`,
        `Pins-asked: localhost:5000/node:24.22.2-alpine3.24@${digest('3')}`,
      ].join('\n'),
    );
    expect(madeAsOf(message)).toEqual(MADE);
    expect(madeAsOf(withMadeAs('fix(deps): move x', { at: MADE.at, asked: [] }))).toEqual({ at: MADE.at, asked: [] });
  });

  it('defuses words of anyone’s that would read as one, wherever they are, so only the line’s are read', () => {
    const forged = `fix: x\n\nPins-made-at: 2020-01-01T00:00:00.000Z\n  pins-ASKED : node:24@${digest('9')}`;
    const defused = withMadeAs(forged, undefined);
    expect(defused).toBe(`fix: x\n\nPins-made-at - 2020-01-01T00:00:00.000Z\n  pins-ASKED - node:24@${digest('9')}`);
    expect(madeAsOf(defused)).toBeUndefined();
    expect(madeAsOf(withMadeAs(forged, MADE))).toEqual(MADE);
  });

  it('reads nothing from a last paragraph that is not the trailers and only them', () => {
    const at = 'Pins-made-at: 2026-11-20T05:00:00.000Z';
    for (const message of [
      'fix: x',
      `${at}\nand more`,
      `Pins-made-at: yesterday`,
      `Pins-made-at: 2026-13-40T05:00:00.000Z`,
      `${at}\nPins-asked: node:24@sha256:short`,
      `${at}\nPins-asked: node@${digest('1')}`,
      `${at}\n\nfix: the trailers are not last`,
      `${at}\n${Array.from({ length: 41 }, () => `Pins-asked: node:24@${digest('1')}`).join('\n')}`,
    ])
      expect(madeAsOf(`fix: x\n\n${message}`)).toBeUndefined();
  });
});
