// Invariants: INV-DEVAI-018
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('reads empty, malformed, and lexically latest proof states fail-closed', async () => {
    const repo = root();
    expect(readLastAgentRunHash(repo)).toBeNull();
    const dir = getAgentRunDir(repo);
    mkdirSync(dir, { recursive: true });
    expect(readLastAgentRunHash(repo)).toBeNull();
    writeFileSync(join(dir, 'AR-a.json'), '{');
    expect(readLastAgentRunHash(repo)).toBeNull();
    writeFileSync(join(dir, 'AR-b.json'), JSON.stringify({ manifest_hash: 'latest-hash' }));
    writeFileSync(join(dir, 'ignored.txt'), 'ignored');
    expect(readLastAgentRunHash(repo)).toBe('latest-hash');
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
