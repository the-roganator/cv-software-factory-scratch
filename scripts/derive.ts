/**
 * The pin step's derivation of moves (apps/runner/src/pins.ts's `writePins`), on a checkout of a commit, in GitHub's
 * runners: the one way a lockfile's package, a tool mise pins, and in the app an image that runs Node, are made, for
 * the two that make them there. The scan (scripts/pins.ts) makes the factory's on the commit it scanned, and the pin
 * watch commits what it made; the review gate (scripts/moves.ts) makes them again on main's tip and compares.
 *
 * Both run it with this repository's own tools: the pnpm its mise.lock holds, found by mise from this checkout and
 * never from the one derived on, and the mise every workflow installs at one release (scripts/toolchain.test.ts), so
 * the same move on the same files writes the same bytes in either. Each runs in an environment of its own (`PATH`, a
 * home, and mise told to trust the checkout's own `mise.toml`): no token, no key, no script, no pnpmfile.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { lockedPnpm } from '../apps/runner/scripts/install-pnpm.ts';
import { type Mise, type Move, pnpmIn, writePins } from '../apps/runner/src/pins.ts';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

/** git in a directory, with no hook and no settings of the checkout's. */
export const gitIn =
  (dir: string) =>
  async (...args: string[]) =>
    (
      await exec(
        'git',
        [
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
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 },
      )
    ).stdout;

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
  const tools = { pnpm: pnpmIn(env), mise: miseIn(env), get: fetch, aside, workspace: derivation.workspace };
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
  return new Map(paths.map((path) => [path, readFileSync(join(dir, path), 'utf-8')]));
}
