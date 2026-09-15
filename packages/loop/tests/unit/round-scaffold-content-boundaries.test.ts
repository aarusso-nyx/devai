import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { scaffoldDecisionRecord, scaffoldGovernedRound } from '../../src/round-lifecycle/index.js';
import { parseGovernanceRecord } from '../../src/governance-ledger/index.js';
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'devai-round-scaffold-'));
  roots.push(path);
  return path;
}

describe('round scaffolds remain working papers and preserve existing content', () => {
  it('creates only the declared working files and empty resource directories', async () => {
    const base = root();
    await withAuthorityHostTestScope(() => {
      const scaffold = scaffoldGovernedRound({ repoRoot: base, round: ' R-42 ' });
      expect(scaffold).toEqual({
        ok: true,
        id: 'R-0042',
        path: 'work/rounds/R-0042',
        files: ['work/rounds/R-0042/plan.md', 'work/rounds/R-0042/prompts/00-orchestrator.md'],
      });
      const directory = join(base, scaffold.path);
      expect(readdirSync(directory).sort()).toEqual(['audit', 'inputs', 'plan.md', 'prompts']);
      expect(readdirSync(join(directory, 'audit'))).toEqual([]);
      expect(readdirSync(join(directory, 'inputs'))).toEqual([]);
      const plan = readFileSync(join(directory, 'plan.md'), 'utf8');
      expect(plan).toContain('# Round 42 plan');
      expect(plan).toContain('scaffolded local working paper; not durable governance authority.');
      expect(plan).toContain('## Goal\n\n(declare the approved goal)');
      expect(plan).toContain('## Waves\n\n(declare role-separated waves and gates)');
      expect(readFileSync(join(directory, 'prompts/00-orchestrator.md'), 'utf8')).toBe(
        '# R-0042 orchestrator\n\nDeterministic local scaffold. Replace this working prompt before execution.\n',
      );
      for (const name of ['AUTHORIZATION.md', 'record.md', 'close-state.jsonl'])
        expect(existsSync(join(directory, name))).toBe(false);
      const before = readFileSync(join(directory, 'plan.md'));
      expect(() => scaffoldGovernedRound({ repoRoot: base, round: 42 })).toThrow(
        'ROUND_ALREADY_EXISTS',
      );
      expect(readFileSync(join(directory, 'plan.md'))).toEqual(before);
    });
  });
  it('does not fill in or overwrite a pre-existing partially scaffolded round', async () => {
    const base = root();
    const directory = join(base, 'work/rounds/R-0042');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'owner-note.txt'), 'preserve\n');
    await withAuthorityHostTestScope(() => {
      expect(() => scaffoldGovernedRound({ repoRoot: base, round: 42 })).toThrow(
        'ROUND_ALREADY_EXISTS',
      );
    });
    expect(readdirSync(directory)).toEqual(['owner-note.txt']);
    expect(readFileSync(join(directory, 'owner-note.txt'), 'utf8')).toBe('preserve\n');
  });
});

describe('decision scaffolds retain identity, dates and proposed standing', () => {
  it('allocates above the largest canonical decision number rather than file count or lexical order', async () => {
    const base = root();
    const dir = join(base, 'law/register');
    mkdirSync(dir, { recursive: true });
    const names = [
      'D-2.md',
      'D-10.md',
      'D-9.md',
      'D-999.md.bak',
      'prefix-D-1000.md',
      'D-not-a-number.md',
      'README.md',
    ];
    for (const name of names) writeFileSync(join(dir, name), 'preserve ' + name);
    await withAuthorityHostTestScope(() => {
      const created = scaffoldDecisionRecord({
        repoRoot: base,
        title: '  Reviewed "decision": ação | scope  ',
        round: 'R-0042',
        now: '2026-09-08T23:45:00.000Z',
      });
      expect(created).toEqual({ ok: true, id: 'D-11', path: 'law/register/D-11.md' });
      const parsed = parseGovernanceRecord(join(base, created.path));
      expect(parsed.frontmatter).toEqual({
        id: 'D-11',
        kind: 'decision',
        title: 'Reviewed "decision": ação | scope',
        status: 'proposed',
        supersedes: [],
        superseded_by: null,
        constitution_articles: [],
        round: 'R-0042',
        date: '2026-09-08',
      });
      expect(parsed.body).toContain('# D-11. Reviewed "decision": ação | scope');
      expect(parsed.body).toContain('## Context\n\n(describe the decision trigger)');
      expect(parsed.body).toContain('## Decision\n\n(state the decision)');
      expect(parsed.body).toContain('## Consequences\n\n(record consequences and alternatives)');
      for (const name of names)
        expect(readFileSync(join(dir, name), 'utf8')).toBe('preserve ' + name);
      expect(scaffoldDecisionRecord({ repoRoot: base, now: '2026-09-09T00:00:00.000Z' }).id).toBe(
        'D-12',
      );
    });
  });
  it.each([undefined, '', ' \t '])(
    'uses the proposed pre-round defaults for title %j without claiming approval',
    async (title) => {
      const base = root();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-09-08T23:59:59.000Z');
      await withAuthorityHostTestScope(() => {
        const created = scaffoldDecisionRecord({
          repoRoot: base,
          ...(title === undefined ? {} : { title }),
        });
        expect(created.id).toBe('D-1');
        expect(parseGovernanceRecord(join(base, created.path)).frontmatter).toEqual({
          id: 'D-1',
          kind: 'decision',
          title: 'New governance decision',
          status: 'proposed',
          supersedes: [],
          superseded_by: null,
          constitution_articles: [],
          round: 'pre-round',
          date: '2026-09-08',
        });
      });
    },
  );
});
