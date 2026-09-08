import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { appendVerbEvidence } from '../../src/evidence/verb-evidence.js';
import { loadChain } from '../../src/evidence/chain.js';
import { deriveEvidenceId } from '../../src/evidence/id-generator.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('current operation evidence', () => {
  it('initializes and appends a schema-valid evidence chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-evidence-'));
    roots.push(root);

    const first = appendVerbEvidence({
      repoRoot: root,
      action: 'verify.translation',
      status: 'completed',
      artifacts: [{ path: '.devai/state/result.json', sha256: null, kind: 'result' }],
      notes: ['report_only=true'],
    });
    const second = appendVerbEvidence({
      repoRoot: root,
      action: 'verify.translation',
      status: 'failed',
    });

    expect(first.ok).toBe(true);
    expect(first.id).toMatch(/^EV-[a-f0-9]{16}$/u);
    expect(second.ok).toBe(true);
    const chain = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
      head: string;
      records: Array<{
        id: string;
        previous_run_hash: string | null;
        manifest_hash: string;
        notes?: string[];
      }>;
    };
    expect(chain.records).toHaveLength(2);
    expect(chain.records[0]?.notes).toEqual(['report_only=true']);
    expect(chain.records[1]).not.toHaveProperty('notes');
    expect(chain.records[0]?.id).toBe(first.id);
    expect(chain.records[1]?.id).toBe(second.id);
    expect(chain.records[1]?.previous_run_hash).toBe(chain.records[0]?.manifest_hash);
    expect(chain.head).toBe(chain.records[1]?.manifest_hash);
    // The identifier must bind exactly the facts that were persisted, including
    // the actor role and previous record, not merely have the right hex shape.
    for (const record of loadChain(join(root, 'record/proofs/chain.json')).records) {
      expect(record.id).toBe(
        deriveEvidenceId({
          timestamp: record.timestamp,
          actor: record.actor,
          actor_role: record.actor_role,
          action: record.action,
          status: record.status,
          git_head_sha: record.context.git.head_sha,
          artifact_sha256s: record.artifacts.map((artifact) => artifact.sha256),
          previous_run_hash: record.previous_run_hash,
        }),
      );
    }
  });

  it('returns an error instead of throwing for an invalid chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-evidence-'));
    roots.push(root);
    // The directory path cannot be parsed as a JSON evidence chain.
    const result = appendVerbEvidence({
      repoRoot: root,
      chainPath: '.',
      action: 'verify.translation',
      status: 'failed',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTypeOf('string');
  });
});

it('does not create a chain for an explicitly non-recording operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-evidence-'));
  roots.push(root);
  expect(
    appendVerbEvidence({
      repoRoot: root,
      action: 'verify.translation',
      status: 'completed',
      automatic: true,
    }),
  ).toEqual({ ok: true });
  expect(existsSync(join(root, 'record'))).toBe(false);
});

it('records explicit automatic=false and preserves an explicitly empty notes population', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-evidence-'));
  roots.push(root);
  const result = appendVerbEvidence({
    repoRoot: root,
    action: 'verify.translation',
    status: 'completed',
    automatic: false,
    notes: [],
  });
  expect(result.ok).toBe(true);
  expect(result.id).toMatch(/^EV-[a-f0-9]{16}$/u);
  const chain = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8'));
  expect(chain.records).toHaveLength(1);
  expect(chain.records[0].notes).toEqual([]);
});
