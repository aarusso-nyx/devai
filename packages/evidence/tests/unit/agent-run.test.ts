// Invariants: INV-DEVAI-018
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  emitAgentRun,
  getAgentRunDir,
  readLastAgentRunHash,
  verifyAgentRunHash,
  type AgentRunRecord,
} from '../../src/agent-run/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

function root(): string {
  const repo = mkdtempSync(join(tmpdir(), 'devai-agent-run-'));
  roots.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of roots.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('agent-run proof records', () => {
  it('starts an empty proof directory without relocating or rewriting unrelated files', async () => {
    const repo = root();
    const dir = join(repo, 'record/proofs/work/agent-runs');
    mkdirSync(dir, { recursive: true });
    const unrelated = Buffer.from([0, 255, 10, 13, 42]);
    writeFileSync(join(dir, 'operator-note.bin'), unrelated);
    expect(getAgentRunDir(repo)).toBe(dir);
    const emission = withAuthorityHostTestScope(() =>
      emitAgentRun({
        repoRoot: repo,
        caller: { kind: 'cli', name: 'empty-history' },
        started_at: '2026-07-24T10:00:00.000Z',
        compliance: { invariant_ids: [] },
      }),
    );
    await expect(emission).resolves.toBeDefined();
    const record = await emission;
    expect(record.prev_hash).toBe('GENESIS');
    expect(readFileSync(join(dir, `${record.run_id}.json`), 'utf8')).toBe(
      `${JSON.stringify(record, null, 2)}\n`,
    );
    expect(readFileSync(join(dir, 'operator-note.bin'))).toEqual(unrelated);
    expect(readdirSync(dir).sort()).toEqual([`${record.run_id}.json`, 'operator-note.bin'].sort());
    expect(readLastAgentRunHash(repo)).toBe(record.manifest_hash);
  });

  it.each([
    'tampered',
    'missing-parent',
    'fork',
    'second-genesis',
    'wrong-filename',
    'invalid-json',
  ] as const)(
    'refuses to append to %s history and preserves every existing byte',
    async (damage) => {
      const repo = root();
      const options = {
        repoRoot: repo,
        caller: { kind: 'cli' as const, name: 'fixture' },
        started_at: '2026-07-24T10:00:00.000Z',
        compliance: { invariant_ids: [] },
      };
      const first = await withAuthorityHostTestScope(() => emitAgentRun(options));
      const second = await withAuthorityHostTestScope(() => emitAgentRun(options));
      const dir = getAgentRunDir(repo);
      const rehash = (record: AgentRunRecord, changes: Partial<AgentRunRecord>): AgentRunRecord => {
        const { manifest_hash: _hash, ...draft } = { ...record, ...changes };
        return { ...draft, manifest_hash: canonicalSha256(draft) };
      };
      if (damage === 'tampered')
        writeFileSync(
          join(dir, `${second.run_id}.json`),
          JSON.stringify({ ...second, files_written: ['hidden.txt'] }),
        );
      if (damage === 'missing-parent')
        writeFileSync(
          join(dir, `${second.run_id}.json`),
          JSON.stringify(rehash(second, { prev_hash: '0'.repeat(64) })),
        );
      if (damage === 'second-genesis')
        writeFileSync(
          join(dir, `${second.run_id}.json`),
          JSON.stringify(rehash(second, { prev_hash: 'GENESIS' })),
        );
      if (damage === 'fork') {
        const fork = rehash(second, {
          run_id: 'AR-019e384d-257c-7000-8000-000000000001',
          prev_hash: first.manifest_hash,
        });
        writeFileSync(join(dir, `${fork.run_id}.json`), JSON.stringify(fork));
      }
      if (damage === 'wrong-filename')
        writeFileSync(join(dir, 'wrong.json'), JSON.stringify(first));
      if (damage === 'invalid-json') writeFileSync(join(dir, 'broken.json'), '{');
      const snapshot = () =>
        Object.fromEntries(
          readdirSync(dir)
            .sort()
            .map((name) => [name, readFileSync(join(dir, name)).toString('hex')]),
        );
      const before = snapshot();
      expect(readLastAgentRunHash(repo)).toBeNull();
      const expectedFailure = {
        tampered: 'agent-run history contains an invalid record',
        'missing-parent': 'agent-run history has a missing predecessor',
        fork: 'agent-run history has branching successors',
        'second-genesis': 'agent-run history has multiple genesis records',
        'wrong-filename': 'agent-run history contains an invalid record',
        'invalid-json': SyntaxError,
      }[damage];
      await expect(withAuthorityHostTestScope(() => emitAgentRun(options))).rejects.toThrow(
        expectedFailure,
      );
      expect(snapshot()).toEqual(before);
    },
  );

  it('extends the hash-chain tip when same-millisecond UUIDs sort in reverse order', async () => {
    const repo = root();
    const dir = getAgentRunDir(repo);
    mkdirSync(dir, { recursive: true });
    const stored = (run_id: string, prev_hash: string): AgentRunRecord => {
      const draft = {
        schemaVersion: '1.0.0' as const,
        run_id,
        prev_hash,
        started_at: '2026-07-24T10:00:00.000Z',
        ended_at: '2026-07-24T10:00:00.000Z',
        caller: { kind: 'cli' as const, name: 'fixture' },
        files_read: [],
        files_written: [],
        commands_run: [],
        compliance: { invariant_ids: [] },
      };
      return { ...draft, manifest_hash: canonicalSha256(draft) };
    };
    const first = stored('AR-019e384d-257c-7fff-bfff-ffffffffffff', 'GENESIS');
    const second = stored('AR-019e384d-257c-7000-8000-000000000000', first.manifest_hash);
    for (const record of [first, second])
      writeFileSync(join(dir, `${record.run_id}.json`), JSON.stringify(record));
    expect(readLastAgentRunHash(repo)).toBe(second.manifest_hash);
    const third = await withAuthorityHostTestScope(() =>
      emitAgentRun({
        repoRoot: repo,
        caller: { kind: 'cli', name: 'third' },
        started_at: '2026-07-24T10:00:01.000Z',
        compliance: { invariant_ids: [] },
      }),
    );
    expect(third.prev_hash).toBe(second.manifest_hash);
    expect(readLastAgentRunHash(repo)).toBe(third.manifest_hash);
  });

  it('does not trust empty or malformed proof states or an unauthenticated hash', async () => {
    const repo = root();
    expect(readLastAgentRunHash(repo)).toBeNull();
    const dir = getAgentRunDir(repo);
    mkdirSync(dir, { recursive: true });
    expect(readLastAgentRunHash(repo)).toBeNull();
    writeFileSync(join(dir, 'AR-a.json'), '{');
    expect(readLastAgentRunHash(repo)).toBeNull();
    writeFileSync(join(dir, 'AR-b.json'), JSON.stringify({ manifest_hash: 'latest-hash' }));
    writeFileSync(join(dir, 'ignored.txt'), 'ignored');
    expect(readLastAgentRunHash(repo)).toBeNull();
  });

  it('emits chained versioned records and detects nested tampering', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      const first = emitAgentRun({
        repoRoot: repo,
        caller: { kind: 'recipe', name: 'devai-fix', version: '1.0.0' },
        started_at: '2026-07-24T10:00:00.000Z',
        ended_at: '2026-07-24T10:00:01.000Z',
        files_read: ['law/constitution.md'],
        files_written: ['record/proof.json'],
        commands_run: [{ argv: ['pnpm', 'test'], exit_code: 0, duration_ms: 10 }],
        subagent_invocations: [
          {
            agent_type: 'inspector',
            prompt_pc_id: 'PC-fixture',
            returned_summary: 'green',
            parent_verification: 'pass',
          },
        ],
        compliance: { invariant_ids: ['INV-DEVAI-001'], overrides_in_play: [] },
        outcome: { status: 'pass', notes: ['verified'] },
      });
      expect(first.run_id).toMatch(
        /^AR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(first.prev_hash).toBe('GENESIS');
      expect(first.outcome).toEqual({ status: 'pass', notes: ['verified'] });
      expect(first.subagent_invocations).toEqual([
        {
          agent_type: 'inspector',
          prompt_pc_id: 'PC-fixture',
          returned_summary: 'green',
          parent_verification: 'pass',
        },
      ]);
      expect(verifyAgentRunHash(first)).toBe(true);

      const second = emitAgentRun({
        repoRoot: repo,
        caller: { kind: 'cli', name: 'fixture' },
        started_at: '2026-07-24T11:00:00.000Z',
        compliance: { invariant_ids: [] },
      });
      expect(second.prev_hash).toBe(first.manifest_hash);
      expect(second.files_read).toEqual([]);
      expect(second.files_written).toEqual([]);
      expect(second.commands_run).toEqual([]);
      expect(second).not.toHaveProperty('outcome');
      expect(second).not.toHaveProperty('subagent_invocations');
      expect(readLastAgentRunHash(repo)).toBe(second.manifest_hash);

      const persisted = JSON.parse(
        readFileSync(join(getAgentRunDir(repo), `${second.run_id}.json`), 'utf8'),
      ) as AgentRunRecord;
      expect(persisted).toEqual(second);
      expect(
        verifyAgentRunHash({
          ...first,
          caller: { ...first.caller, name: 'tampered' },
        }),
      ).toBe(false);
    });
  });
});

it('ignores non-JSON operator notes while extending a verified history', async () => {
  const repo = root();
  const input = {
    repoRoot: repo,
    caller: { kind: 'cli' as const, name: 'fixture' },
    started_at: '2026-07-24T10:00:00.000Z',
    compliance: { invariant_ids: [] },
  };
  const first = await withAuthorityHostTestScope(() => emitAgentRun(input));
  const notes = join(getAgentRunDir(repo), 'operator-notes.txt');
  writeFileSync(notes, 'not a JSON record');
  expect(readLastAgentRunHash(repo)).toBe(first.manifest_hash);
  const second = await withAuthorityHostTestScope(() => emitAgentRun(input));
  expect(second.prev_hash).toBe(first.manifest_hash);
  expect(readFileSync(notes, 'utf8')).toBe('not a JSON record');
});

it.each([
  ['empty caller identity', { caller: { kind: 'cli' as const, name: '' } }],
  ['empty command argv', { commands_run: [{ argv: [], exit_code: 0, duration_ms: 1 }] }],
  [
    'negative command duration',
    { commands_run: [{ argv: ['node'], exit_code: 0, duration_ms: -1 }] },
  ],
  ['fractional exit code', { commands_run: [{ argv: ['node'], exit_code: 0.5, duration_ms: 1 }] }],
] as const)('refuses %s before modifying a verified proof history', async (_label, invalid) => {
  const repo = root();
  const input = {
    repoRoot: repo,
    caller: { kind: 'cli' as const, name: 'fixture' },
    started_at: '2026-07-24T10:00:00.000Z',
    compliance: { invariant_ids: [] },
  };
  const first = await withAuthorityHostTestScope(() => emitAgentRun(input));
  const dir = getAgentRunDir(repo);
  const path = join(dir, `${first.run_id}.json`);
  const before = readFileSync(path);
  await expect(
    withAuthorityHostTestScope(() => emitAgentRun({ ...input, ...invalid })),
  ).rejects.toThrow('agent-run record does not validate');
  expect(readdirSync(dir)).toEqual([`${first.run_id}.json`]);
  expect(readFileSync(path)).toEqual(before);
  expect(readLastAgentRunHash(repo)).toBe(first.manifest_hash);
});
