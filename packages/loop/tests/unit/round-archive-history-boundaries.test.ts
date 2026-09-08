import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roundRecordIntegrity } from '../../src/governance-ledger/index.js';
let root: string;
const rel = 'work/rounds/R-0007';
function write(path: string, body: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(message: string) {
  git('add', '.');
  git(
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
  );
}
function record(status = 'closed', phase = 'PC-0007') {
  return `---\nid: R-0007\ntitle: Fixture round\ntype: round-record\nstatus: ${status}\ndate: 2026-09-08\nauthority: Architect\nphase_closure: ${JSON.stringify(phase)}\n---\n# Round seven\n`;
}
function close() {
  write(rel + '/record.md', record());
  write('record/derived/indexes/rounds.md', 'PC-0007\n');
  commit('close round');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-round-archive-'));
  git('init', '--quiet', '--initial-branch=main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('closed round archive history', () => {
  it('accepts a newly sealed round with a resolved phase closure', () => {
    close();
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
  it('permits scaffold and draft history before the first closed commit', () => {
    write(rel + '/plan.md', '# Initial working plan\n');
    commit('scaffold');
    write(rel + '/record.md', record('draft'));
    commit('draft record');
    write(rel + '/plan.md', '# Refined working plan\n');
    commit('refine draft');
    close();
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
  it('refuses any archive tree change after sealing', () => {
    close();
    write(rel + '/notes.md', 'late edit\n');
    commit('change closed archive');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_ARCHIVE_MUTATED',
          message: 'R-0007 changed after its first closed commit.',
          path: rel,
        },
      ],
    });
  });
  it('retains a detected seal violation even if later commits restore the original tree', () => {
    close();
    const original = readFileSync(join(root, rel, 'record.md'), 'utf8');
    write(rel + '/record.md', original + '\nLate edit\n');
    commit('change closed record');
    write(rel + '/record.md', original);
    commit('restore record');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_ARCHIVE_MUTATED',
          message: 'R-0007 changed after its first closed commit.',
          path: rel,
        },
      ],
    });
  });
  it('does not attribute an unrelated later commit to the sealed round', () => {
    close();
    write('unrelated.md', 'other work\n');
    commit('unrelated work');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
  it.each([
    { label: 'empty', phase: '', ledger: 'PC-0007\n', message: '(none)' },
    { label: 'absent ledger', phase: 'PC-0007', ledger: null, message: 'PC-0007' },
    { label: 'different closure', phase: 'PC-0007', ledger: 'PC-0008\n', message: 'PC-0007' },
  ])('reports $label closure evidence separately', ({ phase, ledger, message }) => {
    write(rel + '/record.md', record('closed', phase));
    if (ledger !== null) write('record/derived/indexes/rounds.md', ledger);
    commit('closed fixture');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_PHASE_CLOSURE_UNRESOLVED',
          message: `R-0007 cites missing phase closure ${message}.`,
          path: rel + '/record.md',
        },
      ],
    });
  });
  it('reports a schema-invalid record with parseable frontmatter', () => {
    write(rel + '/record.md', record('draft').replace('authority: Architect\n', ''));
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_RECORD_SCHEMA_INVALID',
          message: 'R-0007/record.md does not satisfy round-record.schema.json.',
          path: rel + '/record.md',
        },
      ],
    });
  });
  it('reports unavailable verification when a closed record has not entered Git history', () => {
    write(rel + '/record.md', record());
    write('record/derived/indexes/rounds.md', 'PC-0007\n');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_HISTORY_UNAVAILABLE',
          message: 'R-0007 closed history could not be verified completely.',
          path: rel,
        },
      ],
    });
  });
  it('checks only an explicit rounds directory when one is supplied', () => {
    write('selected/R-0008/record.md', record('draft'));
    mkdirSync(join(root, rel), { recursive: true });
    expect(roundRecordIntegrity({ repoRoot: root, roundsDir: 'selected' })).toEqual({
      ok: true,
      findings: [],
    });
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [{ code: 'ROUND_RECORD_MISSING', message: 'R-0007 has no record.md.', path: rel }],
    });
  });
});
