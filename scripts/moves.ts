/**
 * The review gate's moves (scripts/move.ts), worked out where the gate's key is not: review.yml's `move` job runs this,
 * with read-only permissions and the scan's state key alone, from main's whole checkout, and hands the gate one answer
 * for each pull request it would judge. It judges the same pull requests the gate does, by the gate's own code
 * (`review-gate.ts`), in either repository and whoever opened them, fetching each one's two commits as data; it posts
 * nothing, and runs nothing of the pull request's.
 *
 *     node scripts/moves.ts --moves                                  # in review.yml: the answers, as output
 *     node scripts/moves.ts --print [--as-app] <owner/name> <number> # by hand, with SCAN_STATE_KEY
 *
 * The scan's moves are the newest finished run of `vulnerabilities.yml` on `main`, by schedule, push or hand, in the
 * repository itself (state.ts's `latest`): its `moves.json` joined with the state it sealed, as the GitHub worker joins
 * them (github/scanning.ts's `joined`), so a lockfile's move has its package and versions. Nothing a pull request can
 * change. The key comes from SCAN_STATE_KEY, which review.yml takes from the `scan-state` environment only main may
 * use; it is read once and taken out of the environment, so no tool this runs has it. `scanMoves` is the one place the
 * moves come from.
 *
 * The pin step's derivation (`derive`) is the line's own code (apps/runner/src/pins.ts) on a checkout of main's tip,
 * with the pnpm the gate's mise.lock holds, in an environment of its own (`PATH` and a home), no script and no
 * pnpmfile: main's files alone, never the pull request's.
 *
 * A reader that fails, or runs past its time, is a refusal that says what it could not read, and never a package.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { joined, MOVES_FILE, MOVES_FILE_SCHEMA, type ScanRun } from '../apps/factory/src/github/scanning.ts';
import { APP_REPOSITORY } from '../apps/factory/src/repositories.ts';
import type { MovesFile } from '../apps/factory/src/vulnerabilities/moves.ts';
import { latest, openKept, readKey, realStateApi, STATE_KEY } from '../apps/factory/src/vulnerabilities/state.ts';
import { zipEntry } from '../apps/factory/src/vulnerabilities/zip.ts';
import { lockedPnpm } from '../apps/runner/scripts/install-pnpm.ts';
import { type Move as PinStepMove, pnpmIn, writePins } from '../apps/runner/src/pins.ts';
import { type Changed, hunkLines, proveMove, rawEntries, type ScanMove } from './move.ts';
import { type GitHub, type MoveAnswer, main, type PullRequest, type Run } from './review-gate.ts';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

/** When every move's reads have ended, from the job's start: inside the job's time, with room for its answers. */
export const MOVES_MS = 12 * 60_000;
const STARTED = Date.now();

/** The most `moves.json` may hold. */
const MAX_MOVES_BYTES = 8 * 1024 * 1024;

/** The state's key, read once and out of the environment before anything runs. */
const KEY = process.env[STATE_KEY];
delete process.env[STATE_KEY];

const cause = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? '';

/** The scan's moves of a repository, from the scan of `main`: see the module's comment. */
export async function scanMoves(repo: string, token: string, keyText = KEY): Promise<ScanMove[]> {
  if (!keyText) throw new Error(`the move job holds no ${STATE_KEY} to read the scan's state with`);
  const key = readKey(keyText);
  const api = realStateApi(token);
  const kept = await latest(api, repo, 'main', undefined, 'moves');
  if (!kept) throw new Error(`no finished scan of main in ${repo} kept its moves`);
  // The state that run sealed, and no other: the newest before the next run's id is that run's, if it kept one.
  const sealed = await latest(api, repo, 'main', String(BigInt(kept.run) + 1n), 'state');
  if (sealed?.run !== kept.run) throw new Error(`run ${kept.run} of the scan kept its moves and no state`);
  const bytes = zipEntry(kept.archive, MOVES_FILE, MAX_MOVES_BYTES);
  if (!bytes) throw new Error(`run ${kept.run}'s moves hold no ${MOVES_FILE}`);
  const file = MOVES_FILE_SCHEMA.parse(JSON.parse(bytes.toString('utf-8'))) as MovesFile;
  const run: ScanRun = { id: Number(kept.run), event: '', conclusion: null, headSha: '', updatedAt: '', url: '' };
  return joined(repo, run, file, openKept(sealed, key, repo)).moves;
}

/** Each repository's moves, read once a run. */
const read = new Map<string, Promise<ScanMove[]>>();

/**
 * The pnpm the pin step runs: the version the gate's own mise.lock holds, which is the runner image's
 * (`install-pnpm.ts`), found by mise from the gate's checkout and never from the repository's, and refused unless it
 * says it is that version.
 */
async function pinnedPnpm(): Promise<string> {
  const version = lockedPnpm(readFileSync(join(ROOT, 'mise.lock'), 'utf-8'), 'linux-x64').version;
  const path = (await exec('mise', ['which', 'pnpm'], { cwd: ROOT, timeout: 60_000 })).stdout.trim();
  if (!path.startsWith('/') || basename(path) !== 'pnpm') throw new Error(`mise names no pnpm executable: ${path}`);
  const runs = (await exec(path, ['--version'], { cwd: ROOT, timeout: 60_000 })).stdout.trim();
  if (runs !== version) throw new Error(`the gate's pnpm is ${runs}, and its mise.lock holds ${version}`);
  return path;
}

/** git in a directory, with no hook and no settings of the checkout's. */
const gitIn =
  (dir: string) =>
  async (...args: string[]) =>
    (
      await exec('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      })
    ).stdout;

/** The two sides of what the merge makes, fetched as data: main's tip, and the head merged onto it. */
async function sides(repo: string, base: string, mergeBase: string, head: string, work: string) {
  const git = gitIn(join(work, 'repo'));
  mkdirSync(join(work, 'repo'));
  await git('init', '--quiet');
  await git(
    'fetch',
    '--quiet',
    '--depth=1',
    '--no-tags',
    `https://github.com/${repo}.git`,
    ...new Set([base, mergeBase, head]),
  );
  // What the merge makes: the head's change onto the base's tip, from their merge base. A conflict is no move.
  const tree = await git('merge-tree', '--write-tree', `--merge-base=${mergeBase}`, base, head)
    .then((stdout) => stdout.trim().split('\n')[0] ?? '')
    .catch(() => {
      throw new Error(`the head does not merge onto ${base.slice(0, 7)} without a conflict`);
    });
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('git wrote no tree of the merge');
  // Each blob as git stores it: no filter or driver runs. A path not there is undefined.
  const show = (rev: string) => (path: string) =>
    git('cat-file', 'blob', `${rev}:${path}`).then(
      (stdout) => stdout,
      () => undefined,
    );
  const raw = await git('diff', '--raw', '--no-renames', '--no-abbrev', base, tree);
  const changed: Changed[] = await Promise.all(
    rawEntries(raw).map(async (entry) => ({
      ...entry,
      base: await show(base)(entry.path),
      head: await show(tree)(entry.path),
      rewrites: hunkLines(await git('diff', '-U0', '--no-renames', '--no-ext-diff', base, tree, '--', entry.path)),
    })),
  );
  /** The pin step's files for these moves, written on a checkout of main's tip. */
  const derive = async (moves: readonly PinStepMove[]) => {
    const [dir, aside, home] = ['main', 'aside', 'home'].map((d) => join(work, d)) as [string, string, string];
    for (const d of [aside, home]) mkdirSync(d);
    await git('worktree', 'add', '--quiet', '--detach', dir, base);
    const pnpm = await pinnedPnpm();
    // pnpm's environment is its own: no token, no key, and a home of its own.
    const env = { PATH: `${dirname(pnpm)}:${process.env.PATH ?? ''}`, HOME: home };
    for (const move of moves) await writePins(dir, move, { pnpm: pnpmIn(env), get: fetch, aside });
    const there = gitIn(dir);
    await there('add', '--all');
    const paths = (await there('diff', '--cached', '--name-only', '--no-renames', '-z')).split('\0').filter(Boolean);
    return new Map(paths.map((path) => [path, readFileSync(join(dir, path), 'utf-8')]));
  };
  return { changed, base: show(base), derive };
}

/** The move a pull request is, proved (`move.ts`), or why it is not. Into main alone, as the merge makes it. */
export async function readMove(each: Run, pr: PullRequest, github: GitHub): Promise<MoveAnswer> {
  if (pr.base.ref !== 'main') return { none: `it is into ${pr.base.ref}, and a move is judged into main alone` };
  const left = STARTED + MOVES_MS - Date.now();
  if (left < 30_000) return { reason: 'the move job had no time left to work it out' };
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'move-'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error('the move job ran out of time')), left);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      (async (): Promise<MoveAnswer> => {
        let moves = read.get(each.repo);
        if (!moves) {
          moves = scanMoves(each.repo, each.read);
          read.set(each.repo, moves);
        }
        const compare = await github.api<{ merge_base_commit?: { sha?: string }; base_commit?: { sha?: string } }>(
          'GET',
          // Open, against main as it is now; closed (a replay by hand), against the tip it was judged on then.
          `/repos/${each.repo}/compare/${pr.state === 'open' || !pr.base.sha ? pr.base.ref : pr.base.sha}...${pr.head.sha}`,
          each.read,
        );
        const mergeBase = compare.merge_base_commit?.sha;
        const base = compare.base_commit?.sha;
        if (!mergeBase || !base || ![mergeBase, base].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
          return { reason: 'GitHub named no tip and merge base to judge the move from' };
        const two = await sides(each.repo, base, mergeBase, pr.head.sha, work);
        const scan = await moves;
        // Every file an edit pins, at main's tip: a pin the change leaves unmoved is read from there.
        const files = [...new Set(scan.flatMap((move) => move.pins.map((pin) => pin.file)))];
        const texts = new Map(await Promise.all(files.map(async (path) => [path, await two.base(path)] as const)));
        return await proveMove(
          two.changed,
          scan,
          { base: (path) => texts.get(path), derive: two.derive },
          each.repo === APP_REPOSITORY,
        );
      })(),
      expired,
    ]);
  } catch (error) {
    // One line, cut, and never a workflow command. What failed is git, GitHub or the scan's artifacts: the pin step's
    // own failure, whose words may name a package, is said by the rule without them.
    console.log(`::warning::${cause(error).replace(/::/g, ': :')}`);
    return { reason: `the gate could not read what it proves a move by (${cause(error)})` };
  } finally {
    clearTimeout(timer);
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), readMove);
  process.exit();
}
