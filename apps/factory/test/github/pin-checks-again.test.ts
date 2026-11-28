/**
 * A required check that fails or hangs on a pin move's own head is run again from a new head: the queue writes the
 * watch's commit again (`commitAgain`), the same tree on the same parent, with a `Checks-run:` line, so GitHub runs
 * every check and the gate afresh. Through the real pin watch, queue and live actions over one fake repository: the
 * watch takes the commit written again as its own, a restarted worker does too (`own-commit.ts`), and after
 * `RUN_TRIES` runs the pull request is told once and the head waits for Martin. A head left so is made again by the
 * watch on `main`'s head once `main` has moved since and the head is a day old (`SPENT_REMAKE_MS`), and no other is.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { MARTIN } from '../../../../policy/reviews.ts';
import { APP_LOGIN, checksRunOf, DryRunActions, LiveActions, withChecksRun } from '../../src/github/actions.ts';
import { BranchRefused } from '../../src/github/branches.ts';
import { QUEUE_TRIES, RUN_TRIES } from '../../src/github/deploy-queue.ts';
import { DeployRefused } from '../../src/github/deploys.ts';
import { APP_USER, IssueGuard } from '../../src/github/issues.ts';
import type { MergeQueue } from '../../src/github/merging.ts';
import { PASS_MS, readPinScope, SPENT_REMAKE_MS } from '../../src/github/pins.ts';
import { PullStates } from '../../src/github/pull-states.ts';
import { client, quiet } from './fake.ts';
import { type Options, worker } from './pin-worker-harness6.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, pinBranchOf, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const DASHBOARDS = pinBranchOf('example-dashboards');
const ONLY = readPinScope('example-dashboards');

/** A worker over a repository whose required checks conclude at each head as `conclusion` says. */
async function opened(conclusion: NonNullable<Options['conclusion']>, options: Options = {}) {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const today = () => day(scanned, factoryMoves());
  const w = await worker(repo, ONLY, today, closing, { conclusion, ...options });
  await w.watchOnly();
  const pull = repo.pulls.find((p) => p.head === DASHBOARDS && p.state === 'open');
  if (!pull) throw new Error('the pin watch opened nothing');
  return { repo, today, w, pull, first: repo.refs.get(DASHBOARDS) as string };
}

describe('a failed check on a pin move’s own head', () => {
  it('is run again from the watch’s commit written again, the same tree on the same parent, and queued once it passes', async () => {
    // The platform job hung on the first head and was cancelled by its time limit.
    const failed = new Set<string>();
    const { repo, w, pull, first } = await opened((head, check) =>
      check === 'platform' && failed.has(head) ? 'cancelled' : 'success',
    );
    failed.add(first);
    await w.queueOnly();
    const again = repo.refs.get(DASHBOARDS) as string;
    expect(again).not.toBe(first);
    expect(repo.made.get(again)?.parents).toEqual(repo.made.get(first)?.parents);
    expect(repo.treeOf(again)).toBe(repo.treeOf(first));
    expect(repo.made.get(again)).toMatchObject({ committer: 'web-flow' });
    expect(repo.messages.get(again)).toBe(withChecksRun(repo.messages.get(first) as string, 2));
    expect(w.heads.get(FACTORY, DASHBOARDS)).toBe(again);
    expect(repo.refs.has(`factory/pin-next/${DASHBOARDS.split('/').at(-1)}`)).toBe(false);
    expect(w.enqueued).toEqual([]);
    // The watch takes it as its own and writes nothing; its checks passed there, the queue adds it at that head.
    w.sent.length = 0;
    await w.pass();
    expect(writes(w.sent).filter((s) => s.path === '/graphql' || s.path.includes('/git/refs'))).toEqual([]);
    expect(w.enqueued).toEqual([{ number: pull.number, head: again }]);
  });

  it('is written again no more after RUN_TRIES runs, and the pull request is told once, across a restart', async () => {
    const { repo, today, w, pull } = await opened(() => 'failure');
    for (let i = 0; i < RUN_TRIES + 2; i++) await w.pass();
    const last = repo.refs.get(DASHBOARDS) as string;
    expect(checksRunOf(repo.messages.get(last) as string)).toBe(RUN_TRIES);
    // A worker started again takes the head as the watch's own, writes it no more, and says nothing twice.
    const next = await worker(repo, ONLY, today, closing, { conclusion: () => 'failure' });
    next.sent.length = 0;
    await next.pass();
    await next.pass();
    expect(repo.refs.get(DASHBOARDS)).toBe(last);
    expect(next.heads.get(FACTORY, DASHBOARDS)).toBe(last);
    const said = [...w.sent, ...next.sent].filter(
      (s) => s.method === 'POST' && s.path.endsWith(`/issues/${pull.number}/comments`),
    );
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0]?.body)).toContain(`in ${RUN_TRIES} runs`);
    // What happens next is said as it is: the watch makes the move again, and when.
    expect(JSON.stringify(said[0]?.body)).toContain('once `main` has moved and the head is a day old');
    expect([...w.enqueued, ...next.enqueued]).toEqual([]);
  });

  it('is not written again while another required check still runs there', async () => {
    let running = true;
    const { repo, w, first } = await opened((_head, check) =>
      check === 'platform' ? 'failure' : check === 'image builds' && running ? null : 'success',
    );
    await w.queueOnly();
    await w.queueOnly();
    expect(repo.refs.get(DASHBOARDS)).toBe(first);
    running = false;
    await w.queueOnly();
    expect(repo.refs.get(DASHBOARDS)).not.toBe(first);
  });
});

describe('a head out of its check runs', () => {
  const DAY = SPENT_REMAKE_MS;
  /** Checks that fail at every head until `mended`, as a move `main` must change for; and where the queue says so. */
  async function spentHead(options: Options = {}, hold = 'checks-spent') {
    const mended = { main: false };
    const pulls = new PullStates({ sources: () => [] });
    const conclusion = () => (mended.main ? 'success' : 'failure');
    const o = await opened(conclusion, { pulls, ...options });
    for (let i = 0; i < RUN_TRIES; i++) await o.w.queueOnly();
    const spent = o.repo.refs.get(DASHBOARDS) as string;
    expect(checksRunOf(o.repo.messages.get(spent) as string)).toBe(RUN_TRIES);
    expect(pulls.said(FACTORY, o.pull.number, spent)).toMatchObject({ hold });
    return { ...o, mended, pulls, spent, conclusion, head: () => o.repo.refs.get(DASHBOARDS) as string };
  }
  /** Martin's review that asks for changes, as GitHub lists it. */
  const asked = () => [{ user: { id: MARTIN }, state: 'CHANGES_REQUESTED' }];
  const comments = (sent: { method: string; path: string }[], number: number) =>
    sent.filter((s) => s.method === 'POST' && s.path.endsWith(`/issues/${number}/comments`));

  it('is left as it is while it is under a day old, though main has moved', async () => {
    const { repo, w, spent, head } = await spentHead();
    repo.push({ 'README.md': 'mended\n' });
    w.wait(DAY - 2 * PASS_MS);
    await w.pass();
    expect(head()).toBe(spent);
  });

  it('is made again on main’s head once main has moved and it is a day old, with its own runs, and queued once green', async () => {
    const { repo, w, pull, spent, mended, head } = await spentHead();
    const main = repo.push({ 'README.md': 'mended\n' });
    w.wait(DAY);
    await w.watchOnly();
    mended.main = true;
    const again = head();
    expect(again).not.toBe(spent);
    expect(repo.made.get(again)?.parents).toEqual([main]);
    // The same edits, and the first of its own runs.
    expect(repo.file(again, 'deploy/base/dashboards.yaml')).toBe(repo.file(spent, 'deploy/base/dashboards.yaml'));
    expect(checksRunOf(repo.messages.get(again) as string)).toBe(1);
    expect(w.heads.get(FACTORY, DASHBOARDS)).toBe(again);
    await w.queueOnly();
    expect(w.enqueued).toEqual([{ number: pull.number, head: again }]);
  });

  it('is made again once more only a day after its last run, while main moves, and the pull request told no more', async () => {
    const { repo, w, pull, head } = await spentHead();
    repo.push({ 'README.md': 'one\n' });
    w.wait(DAY);
    await w.watchOnly();
    const second = head();
    for (let i = 0; i < RUN_TRIES + 2; i++) await w.queueOnly();
    const last = head();
    expect(checksRunOf(repo.messages.get(last) as string)).toBe(RUN_TRIES);
    expect(repo.made.get(last)?.parents).toEqual(repo.made.get(second)?.parents);
    expect(comments(w.sent, pull.number)).toHaveLength(1);
    // main moves every hour of the day after: nothing is written until the head is a day old.
    for (let hour = 0; hour < 22; hour++) {
      repo.push({ 'README.md': `hour ${hour}\n` });
      await w.pass();
    }
    expect(head()).toBe(last);
    expect(comments(w.sent, pull.number)).toHaveLength(1);
    w.wait(2 * PASS_MS);
    await w.watchOnly();
    expect(head()).not.toBe(last);
  });

  it('is left as it is while the line is stopped, or the level holds it, though the queue ran its checks again', async () => {
    const stop = { stopped: true };
    const stopped = await spentHead({ level: () => ({ autonomy: 'guarded', ...stop }) });
    stopped.repo.push({ 'README.md': 'moved\n' });
    stopped.w.wait(DAY);
    await stopped.w.pass();
    await stopped.w.pass();
    expect(stopped.head()).toBe(stopped.spent);
    // The line started again, it is made again on the next pass.
    stop.stopped = false;
    await stopped.w.watchOnly();
    expect(stopped.head()).not.toBe(stopped.spent);
    // A major at Guarded is said held by the level, whatever its checks, and is Martin's.
    const major = await spentHead({ rule: () => 'major' }, 'level');
    major.repo.push({ 'README.md': 'moved\n' });
    major.w.wait(DAY);
    await major.w.pass();
    await major.w.pass();
    expect(major.head()).toBe(major.spent);
  });

  it('is left to its run once Martin has run its checks again, whatever the queue last said of it', async () => {
    const { repo, w, pull, pulls, spent, mended, head } = await spentHead();
    repo.push({ 'README.md': 'mended\n' });
    w.wait(DAY);
    // The checks pass there now, and the queue has not looked since.
    mended.main = true;
    expect(pulls.said(FACTORY, pull.number, spent)).toMatchObject({ hold: 'checks-spent' });
    await w.watchOnly();
    expect(head()).toBe(spent);
    await w.queueOnly();
    expect(w.enqueued).toEqual([{ number: pull.number, head: spent }]);
  });

  it('is one whose failed check another app posted, too: never run again or told, and made again a day on', async () => {
    const pulls = new PullStates({ sources: () => [] });
    const { repo, w, pull, first } = await opened(() => 'failure', { pulls, app: 'another-app' });
    await w.queueOnly();
    await w.queueOnly();
    expect(repo.refs.get(DASHBOARDS)).toBe(first);
    expect(pulls.said(FACTORY, pull.number, first)).toMatchObject({ hold: 'checks-spent' });
    const main = repo.push({ 'README.md': 'moved\n' });
    w.wait(DAY);
    await w.pass();
    expect(repo.made.get(repo.refs.get(DASHBOARDS) as string)?.parents).toEqual([main]);
    expect(comments(w.sent, pull.number)).toEqual([]);
  });

  it('is left as it is, a day old, while main has not moved', async () => {
    const { w, spent, head } = await spentHead();
    w.wait(3 * DAY);
    await w.pass();
    expect(head()).toBe(spent);
  });

  it('after a restart is made again only once the queue has said it is out of runs', async () => {
    const { repo, today, w, spent, conclusion, head } = await spentHead();
    repo.push({ 'README.md': 'mended\n' });
    w.wait(DAY);
    const pulls = new PullStates({ sources: () => [] });
    const next = await worker(repo, ONLY, today, closing, { conclusion, pulls });
    next.wait(DAY + (RUN_TRIES + 1) * PASS_MS);
    // The watch's first pass takes the head as its own, and knows nothing of its checks.
    await next.watchOnly();
    expect(head()).toBe(spent);
    await next.queueOnly();
    expect(pulls.said(FACTORY, repo.pulls[0]?.number ?? 0, spent)).toMatchObject({ hold: 'checks-spent' });
    await next.watchOnly();
    expect(head()).not.toBe(spent);
  });

  describe('is the only head made again: a day old, main moved, no green head is', () => {
    /** A head, green unless a test says, that the queue holds for the reason the test gives, a day on, main having moved. */
    async function held(options: Options) {
      const pulls = new PullStates({ sources: () => [] });
      const o = await opened(() => 'success', { pulls, ...options });
      await o.w.queueOnly();
      o.repo.push({ 'README.md': 'moved\n' });
      o.w.wait(DAY);
      await o.w.pass();
      await o.w.pass();
      expect(o.repo.refs.get(DASHBOARDS)).toBe(o.first);
      expect(o.w.enqueued).toEqual([]);
      return pulls.said(FACTORY, o.pull.number, o.first)?.hold;
    }

    it('not one the level holds, or the stopped line', async () => {
      expect(await held({ rule: () => 'major' })).toBe('level');
      expect(await held({ level: () => ({ autonomy: 'guarded', stopped: true }) })).toBe('stopped');
    });

    it('not one a person took out of the merge queue', async () => {
      const removed = {
        at: '2026-11-12T09:00:00Z',
        by: 'mrogan',
        reason: 'MANUAL',
        commit: null,
        failures: 0,
        person: true,
        atHead: true,
      } as MergeQueue['removed'];
      expect(await held({ removed: () => removed })).toBe('dequeued');
    });

    it('not one the merge queue itself took out on every try', async () => {
      const removed = {
        at: '2026-11-12T09:00:00Z',
        by: 'github-merge-queue',
        reason: 'FAILED_CHECKS',
        commit: null,
        failures: QUEUE_TRIES,
        person: false,
        atHead: true,
      } as MergeQueue['removed'];
      expect(await held({ removed: () => removed })).toBe('queue-spent');
    });

    it('not one the gate holds, or that Martin asked for changes on, whatever its checks', async () => {
      expect(await held({ rule: () => 'held', conclusion: () => 'failure' })).toBe('held');
      expect(await held({ rule: () => 'held', conclusion: () => 'failure', reviews: asked })).toBe('changes-requested');
    });
  });

  describe('made again, is held by each of Martin’s stops as any head is', () => {
    /** A spent head made again on a mended main: green, at the head the watch wrote. */
    async function remade(options: Options = {}) {
      const s = await spentHead(options);
      s.repo.push({ 'README.md': 'mended\n' });
      s.w.wait(DAY);
      await s.w.watchOnly();
      s.mended.main = true;
      expect(s.head()).not.toBe(s.spent);
      return s;
    }

    it('not queued once the line is stopped, or the gate holds the new head', async () => {
      const stop = { stopped: false };
      const stopped = await remade({ level: () => ({ autonomy: 'guarded', ...stop }) });
      stop.stopped = true;
      await stopped.w.pass();
      expect(stopped.w.enqueued).toEqual([]);
      expect(stopped.pulls.said(FACTORY, stopped.pull.number, stopped.head())).toMatchObject({ hold: 'stopped' });
      // Changes Martin asked for hold it at every head: the gate judges the new one `held`, and nothing queues it.
      const gate = { rule: 'move' as 'move' | 'held' };
      const held = await remade({ rule: () => gate.rule, reviews: () => (gate.rule === 'held' ? asked() : []) });
      gate.rule = 'held';
      await held.w.pass();
      expect(held.w.enqueued).toEqual([]);
      expect(held.pulls.said(FACTORY, held.pull.number, held.head())).toMatchObject({ hold: 'changes-requested' });
    });

    it('not opened again for the same edits once Martin closes it', async () => {
      const { repo, w, pull } = await remade();
      pull.state = 'closed';
      repo.push({ 'README.md': 'later\n' });
      w.wait(2 * DAY);
      await w.pass();
      await w.pass();
      expect(repo.pulls.filter((p) => p.head === DASHBOARDS && p.state === 'open')).toEqual([]);
      expect(w.enqueued).toEqual([]);
    });
  });
});

describe('writing a watch’s commit again', () => {
  const live = (repo: FakeRepo) => {
    const { github } = client(repo.routes());
    return new LiveActions(github, {
      guard: new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: true }) }),
    });
  };

  it('refuses any branch but a pin move’s or a deploy’s, and one that moved since its head was read', async () => {
    const { repo, first } = await opened(() => 'success');
    const actions = live(repo);
    const cart = repo.commitOn('main', { 'README.md': 'cart\n' }, APP_LOGIN, 'web-flow');
    repo.refs.set('factory/1400-cart', cart);
    await expect(actions.commitAgain(FACTORY, 'factory/1400-cart', cart, 2)).rejects.toBeInstanceOf(DeployRefused);
    await expect(actions.commitAgain(FACTORY, 'feat/cart', cart, 2)).rejects.toBeInstanceOf(BranchRefused);
    await expect(actions.commitAgain(FACTORY, DASHBOARDS, cart, 2)).rejects.toMatchObject({ kind: 'conflict' });
    expect(repo.refs.get(DASHBOARDS)).toBe(first);
    expect(repo.refs.get('factory/1400-cart')).toBe(cart);
  });

  it('keeps every other line of the message', () => {
    const made = 'fix(deps): move a\n\nWhy it moves.\n\nCo-Authored-By: someone <someone@example.invalid>';
    const twice = withChecksRun(withChecksRun(made, 2), 3);
    expect(checksRunOf(made)).toBe(1);
    expect(checksRunOf(twice)).toBe(3);
    expect(twice.replace('\n\nChecks-run: 3', '')).toBe(made);
    expect(withChecksRun('chore(pin): move zap', 2)).toBe('chore(pin): move zap\n\nChecks-run: 2');
  });

  it('in a dry run, records it and moves the branch, as the live one would', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'again-dry-'));
    const made = new DryRunActions(new DiskArtifacts(dir), quiet);
    const sha = await made.commitAgain(FACTORY, DASHBOARDS, 'a'.repeat(40), 2);
    expect(made.branchMade(FACTORY, DASHBOARDS)).toBe(sha);
    await expect(made.commitAgain(FACTORY, 'feat/cart', 'a'.repeat(40), 2)).rejects.toBeInstanceOf(BranchRefused);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(records.map((r) => [r.action, r.args])).toEqual([
      ['commitAgain', { branch: DASHBOARDS, head: 'a'.repeat(40), run: 2 }],
    ]);
  });
});
