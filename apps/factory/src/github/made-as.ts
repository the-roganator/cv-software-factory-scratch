/**
 * How the line's pin step made one of the app's moves (`MadeAs`, apps/runner/src/pins.ts), as the commit of its pins
 * says it: the trailers `Pins-made-at` and `Pins-asked`, the message's last paragraph, below the coder's words.
 *
 * The review gate reads them from that commit alone, the App's own, which GitHub made and signed (scripts/moves.ts),
 * and makes the move again as of that time and with those answers, as it makes the factory's as its scan made them: a
 * release out, or a tag pushed again, between the pin step and the gate changes nothing the gate makes. Nobody else
 * can make a commit that is the App's, and the coder's words that would read as a trailer here are defused before the
 * line commits them (`withMadeAs`), so a trailer the gate reads is the line's.
 *
 *     Pins-made-at: 2026-11-21T05:12:33.000Z
 *     Pins-asked: gcr.io/distroless/nodejs24-debian13:nonroot@sha256:…
 */
import type { MadeAs } from '../../../runner/src/pins.ts';

export type { MadeAs };

const AT = 'Pins-made-at';
const ASKED = 'Pins-asked';
/** A line of anyone's that would read as one of the trailers: either word, in any case, then its colon. */
const LOOKS_LIKE = /^(\s*pins-(?:made-at|asked))\s*:/gim;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const ASKED_LINE = /^Pins-asked: ([^\s\p{Cc}@]{1,512}):([\w][\w.-]{0,127})@(sha256:[0-9a-f]{64})$/u;
/** The most answers a commit names: a move asks a tag for each image it pins. */
const MOST_ASKED = 40;

/** A commit's message with the coder's words defused, and the line's trailers last, when the pin step made the move. */
export function withMadeAs(message: string, made: MadeAs | undefined): string {
  const own = message.replace(LOOKS_LIKE, '$1 -');
  if (!made) return own;
  return [
    own.trimEnd(),
    '',
    `${AT}: ${made.at}`,
    ...made.asked.map((each) => `${ASKED}: ${each.image}:${each.tag}@${each.digest}`),
  ].join('\n');
}

/** How the pin step made the move, from a commit's message: its last paragraph, when that is the trailers and only them. */
export function madeAsOf(message: string): MadeAs | undefined {
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const [first = '', ...rest] = (paragraphs.at(-1) ?? '').split('\n');
  const at = first.startsWith(`${AT}: `) ? first.slice(AT.length + 2) : '';
  if (!TIME.test(at) || !Number.isFinite(Date.parse(at)) || rest.length > MOST_ASKED) return undefined;
  const asked: MadeAs['asked'] = [];
  for (const line of rest) {
    const m = ASKED_LINE.exec(line);
    if (!m) return undefined;
    asked.push({ image: m[1] as string, tag: m[2] as string, digest: m[3] as string });
  }
  return { at, asked };
}
