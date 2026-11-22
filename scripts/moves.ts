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
 * as scripts/derive.ts runs it for the scan too: with the pnpm the gate's mise.lock holds and the mise every workflow
 * installs, in an environment of its own (`PATH` and a home), no script and no pnpmfile: main's files alone, never the
 * pull request's. In the factory, whose scan made the moves, it is made as the scan made them: as of the scan's time,
 * and with the digests the scan's step was given (its artifact `pins`, github/made.ts), so a release or a tag pushed
 * since changes nothing the gate makes (`derivationOf`). In the app, whose line's pin step made them, it is made as
 * that step made them: as of its time, and with the digests it was given, which the App's commit of the pins says
 * (`madeOf`, github/made-as.ts). In either repository, an image's target is the digest the scan named for its tag,
 * whatever its registry answers now.
 *
 * A reader that fails, or runs past its time, is a refusal that says what it could not read, and never a package.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MADE_ARTIFACT, MADE_FILE, openMade } from '../apps/factory/src/github/made.ts';
import { type MadeAs, madeAsOf } from '../apps/factory/src/github/made-as.ts';
import { joined, MOVES_FILE, MOVES_FILE_SCHEMA, type ScanRun } from '../apps/factory/src/github/scanning.ts';
import { APP_REPOSITORY } from '../apps/factory/src/repositories.ts';
import type { MovesFile } from '../apps/factory/src/vulnerabilities/moves.ts';
import {
  keptBy,
  latest,
  MAX_SEALED_BYTES,
  openKept,
  readKey,
  realStateApi,
  STATE_KEY,
  type StateApi,
} from '../apps/factory/src/vulnerabilities/state.ts';
import { zipEntry } from '../apps/factory/src/vulnerabilities/zip.ts';
import type { Move as PinStepMove } from '../apps/runner/src/pins.ts';
import { askedKey, type Derivation, deriveOn, gitBytesIn, gitIn } from './derive.ts';
import { type Changed, exactText, hunkLines, proveMove, rawEntries, type ScanMove } from './move.ts';
import { type GitHub, type MoveAnswer, main, type PullRequest, type Run } from './review-gate.ts';
import { FACTORY_APP } from './review-routing.ts';

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

/** The scan's moves of a repository, and what the gate makes them as of: see the module's comment. */
export interface ScanDay {
  moves: ScanMove[];
  /** When the scan judged them (`moves.json`'s `judged`), in milliseconds. */
  judged: number;
  /** The digest each tag of an image was found at by the scan's step, by `askedKey`: none where it made no move. */
  asked: Map<string, string>;
}

/**
 * The digest each tag of an image was found at by a run's step, from what it made (github/made.ts), by `askedKey`:
 * the first group's answer where two asked the same tag. None in the app, whose scan makes no move, or where the run
 * kept nothing (its step failed, or ran before it kept its answers): each tag is asked again.
 */
export async function askedOf(api: StateApi, repo: string, run: string, key: Buffer): Promise<Map<string, string>> {
  const asked = new Map<string, string>();
  const made = repo === APP_REPOSITORY ? undefined : await keptBy(api, repo, run, MADE_ARTIFACT);
  if (!made) return asked;
  const bytes = zipEntry(made.archive, MADE_FILE, MAX_SEALED_BYTES);
  if (!bytes) throw new Error(`run ${run}'s ${MADE_ARTIFACT} holds no ${MADE_FILE}`);
  for (const group of openMade(bytes, key, repo, run).groups)
    for (const each of group.asked ?? [])
      if (!asked.has(askedKey(each.image, each.tag))) asked.set(askedKey(each.image, each.tag), each.digest);
  return asked;
}

/**
 * What the gate's derivation of these moves is made with. The factory's moves are its scan's, made again as the scan
 * made them: as of its time, with the digests its step was given. The app's are its line's, made again as the line's
 * pin step made them (`made`, from the App's commit of its pins: `madeOf`): as of its time, with the digests it was
 * given; where no commit says so, as of now. In either, an image's target is the digest the scan named for its tag,
 * whatever the registry answers now.
 */
export function derivationOf(
  repo: string,
  day: ScanDay,
  moves: readonly PinStepMove[],
  made?: MadeAs,
  now = Date.now(),
): Pick<Derivation, 'workspace' | 'asOf' | 'asked'> {
  // The factory's main is a workspace whose projects name each other; the app's checkout is held to the registry.
  const factory = repo !== APP_REPOSITORY;
  const line = factory ? undefined : made;
  const asked = new Map(
    factory ? day.asked : (line?.asked ?? []).map((each) => [askedKey(each.image, each.tag), each.digest] as const),
  );
  for (const move of moves) {
    const [tag, digest] = move.ecosystem === 'docker' ? move.to.split('@') : [];
    if (tag && digest) asked.set(askedKey(move.name, tag), digest);
  }
  // A time ahead of the gate's own is none the pin step made a move at: the gate's, then.
  const asOf = factory ? day.judged : line && Math.min(Date.parse(line.at), now);
  return { workspace: factory, asked, ...(asOf !== undefined && { asOf }) };
}

/** A pull request's commits, as GitHub lists them, read for whose each is and what it says. */
interface Commit {
  author?: { id?: number } | null;
  committer?: { login?: string } | null;
  commit?: { message?: string; verification?: { verified?: boolean } };
}

/**
 * How the line's pin step made the moves a pull request in the app carries: what the newest of its commits that is the
 * App's own says (`made-as.ts`), made and signed by GitHub as every commit of the App's is (`createCommitOnBranch`: its
 * author the App, its committer `web-flow`, its signature verified), which nobody else can make. Undefined where none
 * says, and in the factory, whose moves are its scan's.
 */
export async function madeOf(each: Run, pr: PullRequest, github: GitHub): Promise<MadeAs | undefined> {
  if (each.repo !== APP_REPOSITORY) return undefined;
  const commits = await github.api<Commit[]>(
    'GET',
    `/repos/${each.repo}/pulls/${pr.number}/commits?per_page=100`,
    each.read,
  );
  for (const commit of [...(Array.isArray(commits) ? commits : [])].reverse()) {
    if (commit.author?.id !== FACTORY_APP || commit.committer?.login !== 'web-flow') continue;
    if (commit.commit?.verification?.verified !== true) continue;
    const made = madeAsOf(commit.commit.message ?? '');
    if (made) return made;
  }
  return undefined;
}

/** The scan's moves of a repository, from the scan of `main`: see the module's comment. */
export async function scanMoves(
  repo: string,
  token: string,
  keyText = KEY,
  api: StateApi = realStateApi(token),
): Promise<ScanDay> {
  if (!keyText) throw new Error(`the move job holds no ${STATE_KEY} to read the scan's state with`);
  const key = readKey(keyText);
  const kept = await latest(api, repo, 'main', undefined, 'moves');
  if (!kept) throw new Error(`no finished scan of main in ${repo} kept its moves`);
  // The state that run sealed, and no other: the newest before the next run's id is that run's, if it kept one.
  const sealed = await latest(api, repo, 'main', String(BigInt(kept.run) + 1n), 'state');
  if (sealed?.run !== kept.run) throw new Error(`run ${kept.run} of the scan kept its moves and no state`);
  const bytes = zipEntry(kept.archive, MOVES_FILE, MAX_MOVES_BYTES);
  if (!bytes) throw new Error(`run ${kept.run}'s moves hold no ${MOVES_FILE}`);
  const file = MOVES_FILE_SCHEMA.parse(JSON.parse(bytes.toString('utf-8'))) as MovesFile;
  const run: ScanRun = { id: Number(kept.run), event: '', conclusion: null, headSha: '', updatedAt: '', url: '' };
  const { moves } = joined(repo, run, file, openKept(sealed, key, repo));
  return { moves, judged: Date.parse(file.judged), asked: await askedOf(api, repo, kept.run, key) };
}

/** Each repository's moves, read once a run. */
const read = new Map<string, Promise<ScanDay>>();

/**
 * What a merge is judged on: a pull request's head merged onto main's tip, from their merge base; or the merge queue's
 * commit for it, onto the commit it was made on, main's tip with every entry ahead of it in the queue.
 */
export type Merge = { base: string; mergeBase: string; head: string } | { queue: string };

/**
 * The two sides of what the merge makes, fetched as data from `source`, GitHub's copy of the repository: the commit it
 * merges onto, and the tree it makes there; and the pin step's derivation there, made as of the scan's `day`, or in the
 * app as the line's pin step `made` it.
 */
export async function sides(
  repo: string,
  merge: Merge,
  work: string,
  day: ScanDay,
  source = `https://github.com/${repo}.git`,
  made?: MadeAs,
) {
  const git = gitIn(join(work, 'repo'));
  const bytes = gitBytesIn(join(work, 'repo'));
  mkdirSync(join(work, 'repo'));
  await git('init', '--quiet');
  const shas = 'queue' in merge ? [merge.queue] : [...new Set([merge.base, merge.mergeBase, merge.head])];
  // The queue's commit with the one it was made on.
  const depth = 'queue' in merge ? '--depth=2' : '--depth=1';
  await git('fetch', '--quiet', depth, '--no-tags', source, ...shas);
  const sha = async (rev: string) => {
    const said = (await git('rev-parse', '--verify', '--quiet', rev).catch(() => '')).trim();
    if (!/^[0-9a-f]{40}$/.test(said)) throw new Error(`git names no commit ${rev}`);
    return said;
  };
  let base: string;
  let tree: string;
  if ('queue' in merge) {
    // What the queue merges is its commit's own tree, on its first parent: the entries ahead of it are in that parent,
    // so the moves are made on what they leave, and a combination nothing derived is no move.
    base = await sha(`${merge.queue}^1`);
    tree = await sha(`${merge.queue}^{tree}`);
  } else {
    base = merge.base;
    // What the merge makes: the head's change onto the base's tip, from their merge base. A conflict is no move.
    tree = await git('merge-tree', '--write-tree', `--merge-base=${merge.mergeBase}`, merge.base, merge.head)
      .then((stdout) => stdout.trim().split('\n')[0] ?? '')
      .catch(() => {
        throw new Error(`the head does not merge onto ${merge.base.slice(0, 7)} without a conflict`);
      });
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('git wrote no tree of the merge');
  }
  // Each blob as git stores it, its bytes: no filter or driver runs, and nothing is decoded but strictly
  // (`exactText`), null where it is not UTF-8. A path not there is undefined.
  const blob = (rev: string) => (path: string) =>
    bytes('cat-file', 'blob', `${rev}:${path}`).then(
      (stdout) => exactText(stdout),
      () => undefined,
    );
  const show = (rev: string) => async (path: string) => (await blob(rev)(path)) ?? undefined;
  const raw = await git('diff', '--raw', '--no-renames', '--no-abbrev', base, tree);
  const changed: Changed[] = await Promise.all(
    rawEntries(raw).map(async (entry) => ({
      ...entry,
      base: await blob(base)(entry.path),
      head: await blob(tree)(entry.path),
      rewrites: hunkLines(await git('diff', '-U0', '--no-renames', '--no-ext-diff', base, tree, '--', entry.path)),
    })),
  );
  /** The pin step's files for these moves, written on a checkout of main's tip (scripts/derive.ts). */
  const derive = async (moves: readonly PinStepMove[]) => {
    const dir = join(work, 'main');
    await git('worktree', 'add', '--quiet', '--detach', dir, base);
    const own = join(work, 'derive');
    mkdirSync(own);
    return deriveOn(dir, moves, { work: own, ...derivationOf(repo, day, moves, made), token: process.env.GH_TOKEN });
  };
  return { changed, base: show(base), derive };
}

/**
 * What a pull request's merge is judged on: for the merge queue's commit made for it, that commit (`Run`'s `queue`);
 * otherwise its head onto main's tip, as GitHub names them.
 */
export async function mergeOf(each: Run, pr: PullRequest, github: GitHub): Promise<Merge> {
  if (each.queue?.number === pr.number) return { queue: each.queue.commit };
  const compare = await github.api<{ merge_base_commit?: { sha?: string }; base_commit?: { sha?: string } }>(
    'GET',
    // Open, against main as it is now; closed (a replay by hand), against the tip it was judged on then.
    `/repos/${each.repo}/compare/${pr.state === 'open' || !pr.base.sha ? pr.base.ref : pr.base.sha}...${pr.head.sha}`,
    each.read,
  );
  const mergeBase = compare.merge_base_commit?.sha;
  const base = compare.base_commit?.sha;
  if (!mergeBase || !base || ![mergeBase, base].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
    throw new Error('GitHub named no tip and merge base to judge the move from');
  return { base, mergeBase, head: pr.head.sha };
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
        const day = await moves;
        const made = await madeOf(each, pr, github);
        const two = await sides(each.repo, await mergeOf(each, pr, github), work, day, undefined, made);
        const scan = day.moves;
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
