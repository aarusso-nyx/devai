import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-adapters-provenance-depth-'));
  roots.push(value);
  return value;
}

function put(base: string, relativePath: string, value: string): void {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function member(): Parameters<typeof executeCheckMember>[0] {
  return {
    id: 'provenance-readiness',
    source: 'current-selector',
    service_id: 'provenance-readiness',
    binding: { kind: 'runtime-gate', gate_id: 'check-provenance-readiness' },
    effect: 'read' as const,
    cost: 'low' as const,
    output: 'action-envelope-plus-provenance-readiness',
  };
}

async function execute(repoRoot: string) {
  return withAuthorityHostTestScope(() => executeCheckMember(member(), { repoRoot }));
}

describe('check adapter provenance readiness boundaries', () => {
  it('reports unknown when no provenance records exist', async () => {
    const repo = root();
    const result = await execute(repo);
    expect(result.status).toBe('unknown');
    expect(result.value).toMatchObject({
      status: 'unknown',
      reason: 'no artifact/source provenance record is available',
    });
  });

  it('fails when any discovered provenance record is malformed', async () => {
    const repo = root();
    put(repo, 'record/proofs/compliance/releases/valid.json', '{"release":"r1"}\n');
    put(repo, '.devai/state/releases/broken.json', '{\n');
    const result = await execute(repo);
    expect(result.status).toBe('fail');
    expect(result.value).toMatchObject({ ok: false });
    expect((result.value as { records: string[] }).records).toHaveLength(2);
    expect((result.value as { malformed: string[] }).malformed).toEqual([
      join(repo, '.devai/state/releases/broken.json'),
    ]);
  });

  it('passes when every discovered provenance record is a JSON object', async () => {
    const repo = root();
    put(repo, 'record/proofs/compliance/releases/first.json', '{"release":"r1"}\n');
    put(repo, '.devai/state/releases/second.json', '{"release":"r2"}\n');
    const result = await execute(repo);
    expect(result.status).toBe('pass');
    expect(result.value).toMatchObject({ ok: true, malformed: [] });
    expect((result.value as { records: string[] }).records).toEqual([
      join(repo, 'record/proofs/compliance/releases/first.json'),
      join(repo, '.devai/state/releases/second.json'),
    ]);
  });
});
