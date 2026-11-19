import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Made, openMade, sealMade } from '../apps/factory/src/github/made.ts';
import type { ReadMove } from '../apps/factory/src/github/scanning.ts';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../apps/factory/src/repositories.ts';
import { newKey, readKey } from '../apps/factory/src/vulnerabilities/state.ts';
import { PinsRefused } from '../apps/runner/src/pins.ts';
import { groupsOf, makeGroup } from './pins.ts';

const LOCK = (a: string, b: string) =>
  `lockfileVersion: '9.0'\n\npackages:\n\n  example-a@${a}:\n    resolution: {integrity: sha512-a}\n\n  example-b@${b}:\n    resolution: {integrity: sha512-b}\n`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-pins-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '--message', 'scanned');
  return dir;
}

const COUNTS = { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
const npm = (index: number, name: string, from: string, to: string, lane: ReadMove['lane'] = 'worker'): ReadMove => ({
  repository: FACTORY_REPOSITORY,
  index,
  name: 'a package in `pnpm-lock.yaml`',
  pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
  from: '',
  to: '',
  major: false,
  clears: COUNTS,
  leaves: COUNTS,
  newToday: 0,
  lane,
  lockfile: true,
  withheld: { package: name, from, to: `version ${to}`, pins: [{ file: 'pnpm-lock.yaml', line: 5 }] },
  findings: [],
});

describe('the scan’s making of the moves the pin watch commits', () => {
  it('makes the factory’s worker moves the step makes, by group, in the order of moves.json, and the app’s none', () => {
    const image: ReadMove = {
      ...npm(3, '', '', ''),
      lockfile: false,
      name: 'postgres',
      pins: [{ file: 'a.yaml', line: 1 }],
    };
    const tools: ReadMove = {
      ...image,
      index: 4,
      name: 'ghcr.io/k3d-io/k3d-tools',
      pins: [{ file: 'mise.lock', line: 2 }],
    };
    // Playwright's image brings its library in the lockfile: it is made with the day's lockfile moves, in their order.
    const playwright: ReadMove = {
      ...image,
      index: 5,
      name: 'mcr.microsoft.com/playwright',
      pins: [{ file: 'apps/factory/Dockerfile.browser', line: 26 }],
      from: 'v1.65.0-noble',
      to: `image v1.65.1-noble@sha256:${'1'.repeat(64)}`,
    };
    // Node's image brings the Node it runs: its Dockerfiles' group, made by the step.
    const node: ReadMove = {
      ...image,
      index: 6,
      name: 'node',
      pins: [{ file: 'apps/factory/Dockerfile', line: 11 }],
      from: '24.22.2-alpine3.24',
      to: `image 24.22.3-alpine3.24@sha256:${'2'.repeat(64)}`,
    };
    const moves = [
      npm(1, 'example-a', '1.0.0', '1.0.1'),
      image,
      npm(2, 'example-b', '2.0.0', '2.0.3'),
      tools,
      playwright,
      node,
    ];
    const groups = [...groupsOf(moves, FACTORY_REPOSITORY).values()];
    expect(groups.map((group) => group.map((move) => move.index))).toEqual([[1, 2, 5], [4], [6]]);
    expect(groupsOf(moves, APP_REPOSITORY).size).toBe(0);
    // An issue's lane is not the watch's.
    expect(groupsOf([npm(1, 'example-a', '1.0.0', '1.0.1', 'issue')], FACTORY_REPOSITORY).size).toBe(0);
  });

  it('keeps what each made move moved, as the diff shows it, and a refused move with the step’s words', async () => {
    const dir = checkout({ 'pnpm-lock.yaml': LOCK('1.0.0', '2.0.0') });
    const group = await makeGroup(
      dir,
      [npm(1, 'example-a', '1.0.0', '1.0.1'), npm(2, 'example-b', '2.0.0', '2.0.3')],
      mkdtempSync(join(tmpdir(), 'scan-pins-work-')),
      async (checkoutDir, steps, derivation) => {
        expect(derivation.workspace).toBe(true);
        expect(steps.map((step) => step.name)).toEqual(['example-a', 'example-b']);
        derivation.refused?.(steps[1] as (typeof steps)[number], new PinsRefused('example-b@2.0.3 is too young'));
        expect(checkoutDir).not.toBe(dir);
        return new Map([['pnpm-lock.yaml', LOCK('1.0.1', '2.0.0')]]);
      },
    );
    expect(group).toEqual({
      files: ['pnpm-lock.yaml'],
      major: false,
      moves: [1],
      refused: [{ move: 2, reason: 'example-b@2.0.3 is too young' }],
      changed: [{ path: 'pnpm-lock.yaml', text: LOCK('1.0.1', '2.0.0') }],
      steps: [{ move: 1, ecosystem: 'npm', name: 'example-a', before: ['1.0.0'], after: ['1.0.1'] }],
    });
  });

  it('seals what it made for its repository and run alone', () => {
    const key = readKey(newKey());
    const made: Made = {
      version: 1,
      repository: FACTORY_REPOSITORY,
      run: '7',
      commit: 'a'.repeat(40),
      groups: [
        {
          files: ['mise.lock'],
          major: false,
          moves: [4],
          refused: [],
          changed: [{ path: 'mise.lock', text: 'x' }],
          steps: [{ move: 4, ecosystem: 'tool', name: 'k3d', before: ['5.8.3'], after: ['5.9.0'] }],
        },
      ],
    };
    const sealed = sealMade(made, key);
    expect(sealed.toString('latin1')).not.toContain('k3d');
    expect(openMade(sealed, key, FACTORY_REPOSITORY, '7')).toEqual(made);
    expect(() => openMade(sealed, key, FACTORY_REPOSITORY, '8')).toThrow(/does not open with this key for run 8/);
    expect(() => openMade(sealed, readKey(newKey()), FACTORY_REPOSITORY, '7')).toThrow(/does not open/);
    const bad = sealMade(
      { ...made, groups: [{ ...(made.groups[0] as Made['groups'][number]), changed: [{ path: '../x', text: '' }] }] },
      key,
    );
    expect(() => openMade(bad, key, FACTORY_REPOSITORY, '7')).toThrow(/a file that is not one/);
  });
});
