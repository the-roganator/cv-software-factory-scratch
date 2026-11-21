/**
 * The pin step's derivation of moves (apps/runner/src/pins.ts's `writePins`), on a checkout of a commit, in GitHub's
 * runners: the one way a lockfile's package, a tool mise pins, and in the app an image that runs Node, are made, for
 * the two that make them there. The scan (scripts/pins.ts) makes the factory's on the commit it scanned, and the pin
 * watch commits what it made; the review gate (scripts/moves.ts) makes them again on main's tip and compares.
 *
 * Both run it with this repository's own tools: the pnpm its mise.lock holds, found by mise from this checkout and
 * never from the one derived on, and the mise every workflow installs at one release (scripts/toolchain.test.ts), so
 * the same move on the same files writes the same bytes in either. Each runs in an environment of its own (`PATH`, a
 * home, and mise told to trust the checkout's own `mise.toml`): no token, no key, no script, no pnpmfile. The job's
 * read-only token, where it is given one, goes only on the step's own requests to GitHub's API (a tool's releases,
 * `moveTool`), so they are held to the token's rate rather than the runner's address's, and never to pnpm or mise.
 *
 * Both make it as of one time and with one set of the registries' answers, so a move made later is the same move:
 *
 * - **As of the scan** (`Derivation.asOf`, `moves.json`'s `judged`): pnpm takes no release published later than its
 *   release age before it, whenever it runs, as the scan's own pnpm would have; and the step's clock, by which a Node
 *   release or a tool's is old enough for mise's `minimum_release_age` (`moveNode`, `moveTool`), reads it too. A
 *   release out between the scan and the gate is one neither takes.
 * - **With the digests the scan was given** (`Derivation.asked`): each tag of an image the scan's step asked its
 *   registry for is answered as the registry answered it then, sealed with what the scan made (github/made.ts), so a
 *   tag the registry has pushed again since moves nothing the gate makes. A tag it never asked is asked now.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { lockedPnpm } from '../apps/runner/scripts/install-pnpm.ts';
import {
  type DigestOf,
  digestOf,
  type Get,
  type Mise,
  type Move,
  PinsRefused,
  type Pnpm,
  pnpmIn,
  writePins,
} from '../apps/runner/src/pins.ts';
import { exactText } from './move.ts';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

/** git's arguments in a directory, with no hook and no settings of the checkout's. */
const gitArgs = (dir: string, args: string[]) => [
  '-C',
  dir,
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'user.name=pins',
  '-c',
  'user.email=pins@factory.invalid',
  ...args,
];
const GIT_LIMITS = { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 };

/** git in a directory, with no hook and no settings of the checkout's. */
export const gitIn =
  (dir: string) =>
  async (...args: string[]) =>
    (await exec('git', gitArgs(dir, args), GIT_LIMITS)).stdout;

/** git in a directory as `gitIn` runs it, its output the bytes it wrote: a blob as git stores it. */
export const gitBytesIn =
  (dir: string) =>
  async (...args: string[]) =>
    (await exec('git', gitArgs(dir, args), { ...GIT_LIMITS, encoding: 'buffer' })).stdout;

/**
 * The pnpm the derivation runs: the version this repository's mise.lock holds, which is the runner image's
 * (`install-pnpm.ts`), found by mise from this checkout, and refused unless it says it is that version.
 */
export async function pinnedPnpm(root = ROOT): Promise<string> {
  const version = lockedPnpm(readFileSync(join(root, 'mise.lock'), 'utf-8'), 'linux-x64').version;
  const path = (await exec('mise', ['which', 'pnpm'], { cwd: root, timeout: 60_000 })).stdout.trim();
  if (!path.startsWith('/') || basename(path) !== 'pnpm') throw new Error(`mise names no pnpm executable: ${path}`);
  const runs = (await exec(path, ['--version'], { cwd: root, timeout: 60_000 })).stdout.trim();
  if (runs !== version) throw new Error(`this checkout's pnpm is ${runs}, and its mise.lock holds ${version}`);
  return path;
}

/** mise, in a checkout whose own `mise.toml` it is told to trust, in the derivation's environment. */
export function miseIn(env: NodeJS.ProcessEnv): Mise {
  return async (dir, args) => {
    await exec('mise', args, {
      cwd: dir,
      env: { ...env, MISE_TRUSTED_CONFIG_PATHS: dir, MISE_YES: '1', CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
  };
}

/** A fetch that gives GitHub's API the token, where there is one, and every other host nothing. */
export function githubGet(token: string | undefined, get: Get = fetch): Get {
  return (url, init) => {
    if (!token || new URL(url).origin !== 'https://api.github.com') return get(url, init);
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return get(url, { ...init, headers });
  };
}

/** pnpm's own release age, in minutes, where its settings name none: a day. */
export const PNPM_RELEASE_AGE = 24 * 60;

/** A checkout's pnpm release age, in minutes: its `pnpm-workspace.yaml`'s `minimumReleaseAge`, or pnpm's own. */
export function pnpmAge(workspace: string): number {
  if (!/^minimumReleaseAge\b/m.test(workspace)) return PNPM_RELEASE_AGE;
  const set = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(workspace);
  if (!set) throw new PinsRefused("pnpm-workspace.yaml's minimumReleaseAge is not a number of minutes.");
  return Number(set[1]);
}

/**
 * pnpm, made to resolve as of a time: told on its command line, over any setting of the checkout's, to take no
 * release younger than the checkout's own release age at `asOf`, which is that age and the time since. Never less
 * than the checkout's age now, and rounded up to pnpm's minute.
 */
export function pnpmAsOf(pnpm: Pnpm, asOf: number, now: () => number = Date.now): Pnpm {
  return async (dir, args) => {
    const workspace = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf-8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    const minutes = pnpmAge(workspace) + Math.ceil(Math.max(0, now() - asOf) / 60_000);
    await pnpm(dir, [`--config.minimum-release-age=${minutes}`, ...args]);
  };
}

/** The key of a tag's answer in `Derivation.asked`. */
export const askedKey = (image: string, tag: string) => `${image}:${tag}`;

/** What a derivation needs besides the moves. */
export interface Derivation {
  /** A folder of its own, for a home and what pnpm moves aside. */
  work: string;
  /** Whether the checkout's own workspace projects may be named: the factory's `main`, never an agent's checkout. */
  workspace: boolean;
  /**
   * Given, a move the step refuses is undone and passed here, and the rest go on; not given, the first refusal throws.
   * What it is given may name a package a lockfile's move withholds.
   */
  refused?: (move: Move, error: unknown) => void;
  /** The pnpm to run; this checkout's (`pinnedPnpm`) when not given. */
  pnpm?: string;
  /** The job's read-only token, for GitHub's API alone (`githubGet`); none, and its requests go without one. */
  token?: string | undefined;
  /** The time it is made as of, in milliseconds: the scan's (`moves.json`'s `judged`). Not given, now. */
  asOf?: number | undefined;
  /**
   * The digest each tag of an image was found at, by `askedKey`: a tag it holds is answered from it, and one it does
   * not is asked of its registry and its answer added. The scan's step fills an empty one, which it seals; the gate
   * gives what the scan sealed.
   */
  asked?: Map<string, string> | undefined;
  /** How a registry is reached; `fetch`, with `token` on GitHub's API alone (`githubGet`), when not given. */
  get?: Get;
}

/**
 * Makes the moves, in order, on a checkout at a commit, each on what the ones before it wrote, and gives every file
 * that then differs from that commit, with its text. The checkout is a worktree of its own: each move is committed on
 * it as it is made, so a refused one is undone alone.
 */
export async function deriveOn(
  dir: string,
  moves: readonly Move[],
  derivation: Derivation,
): Promise<Map<string, string>> {
  const git = gitIn(dir);
  const base = (await git('rev-parse', 'HEAD')).trim();
  const [aside, home] = ['aside', 'home'].map((d) => join(derivation.work, d)) as [string, string];
  for (const d of [aside, home]) mkdirSync(d, { recursive: true });
  const pnpm = derivation.pnpm ?? (await pinnedPnpm());
  // pnpm's and mise's environment is their own: no token, no key, and a home of its own.
  const env = { PATH: `${dirname(pnpm)}:${process.env.PATH ?? ''}`, HOME: home };
  const { asOf, asked } = derivation;
  const get: Get = derivation.get ?? githubGet(derivation.token);
  const digest: DigestOf = async (image, tag) => {
    const known = asked?.get(askedKey(image, tag));
    if (known) return known;
    const answer = await digestOf(image, tag, get);
    asked?.set(askedKey(image, tag), answer);
    return answer;
  };
  const tools = {
    pnpm: asOf === undefined ? pnpmIn(env) : pnpmAsOf(pnpmIn(env), asOf),
    mise: miseIn(env),
    get,
    aside,
    workspace: derivation.workspace,
    digestOf: digest,
    ...(asOf !== undefined && { now: asOf }),
  };
  for (const move of moves) {
    try {
      await writePins(dir, move, tools);
    } catch (error) {
      if (!derivation.refused) throw error;
      await git('reset', '--quiet', '--hard');
      await git('clean', '-fdq');
      derivation.refused(move, error);
      continue;
    }
    await git('add', '--all');
    await git('commit', '--quiet', '--allow-empty', '--no-verify', '--message', 'move');
  }
  const paths = (await git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')).split('\0').filter(Boolean);
  // Each as its bytes are: one that is not UTF-8 is no file a move writes.
  return new Map(
    paths.map((path) => {
      const text = exactText(readFileSync(join(dir, path)));
      if (text === null) throw new Error(`the pin step wrote ${path}, which is not UTF-8 text`);
      return [path, text];
    }),
  );
}
