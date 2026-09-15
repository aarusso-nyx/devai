import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decisionRecordIntegrity } from '../../src/governance-ledger/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-decision-stable-transition-'));
  roots.push(root);
  return root;
}

function write(path: string, source: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function recordSource(
  options: {
    readonly id?: string;
    readonly status?: 'active' | 'superseded';
    readonly supersededBy?: string;
    readonly supersedes?: string;
    readonly body?: string;
  } = {},
): string {
  const id = options.id ?? 'ADR-001';
  return [
    '---',
    `id: ${id}`,
    'title: Fixture decision',
    'type: adr',
    `status: ${options.status ?? 'active'}`,
    'date: 2026-09-08',
    'authority: Architect',
    `supersedes: ${options.supersedes ?? '[]'}`,
    `superseded_by: ${options.supersededBy ?? 'null'}`,
    'provenance: [fixture, source-7]',
    'affected_rules:',
    '  - id: RULE-1',
    '    enabled: true',
    '---',
    '',
    options.body ?? `# ${id}. Fixture decision`,
    '',
  ].join('\n');
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { cwd: root },
  );
}

function initGit(root: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
}

describe('decision sealed transition boundaries', () => {
  it('permits an empty replacement to become one canonical successor', () => {
    const root = fixtureRoot();
    const path = write(
      join(root, 'law/adr/ADR-001.md'),
      recordSource({ status: 'active', supersededBy: "''" }),
    );
    initGit(root);
    commitAll(root, 'activate with empty replacement');
    writeFileSync(path, recordSource({ status: 'superseded', supersededBy: 'ADR-002' }));
    write(
      join(root, 'law/adr/ADR-002.md'),
      recordSource({ id: 'ADR-002', status: 'active', supersedes: '[ADR-001]' }),
    );
    commitAll(root, 'canonical successor');

    expect(decisionRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
});
