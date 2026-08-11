import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { appendVerbEvidence } from '../../src/evidence/verb-evidence.js';
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
      records: Array<{ id: string; previous_run_hash: string | null; manifest_hash: string }>;
    };
    expect(chain.records).toHaveLength(2);
    expect(chain.records[0]?.id).toBe(first.id);
    expect(chain.records[1]?.id).toBe(second.id);
    expect(chain.records[1]?.previous_run_hash).toBe(chain.records[0]?.manifest_hash);
    expect(chain.head).toBe(chain.records[1]?.manifest_hash);
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
