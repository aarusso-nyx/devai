import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitAgentRun, getAgentRunDir } from '../../src/agent-run/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

// Controlled entropy makes UUID layout and the exclusive-write collision behavior
// deterministic. Hashing and the authority host fixture retain their real implementations.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      size === 10 ? Buffer.from('a1b2c3d4e5f60718293a', 'hex') : actual.randomBytes(size),
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function options() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'devai-agent-identity-'));
  roots.push(repoRoot);
  return {
    repoRoot,
    caller: { kind: 'cli' as const, name: 'identity-fixture' },
    started_at: '2026-09-07T19:00:00.000Z',
    ended_at: '2026-09-07T19:00:01.000Z',
    compliance: { invariant_ids: [] },
  };
}

describe('agent-run identity and exclusive persistence', () => {
  it('encodes the timestamp, version, variant and every available random byte in its UUID', async () => {
    const timestamp = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(timestamp);
    const result = await withAuthorityHostTestScope(() => emitAgentRun(options()));
    const timeHex = timestamp.toString(16).padStart(12, '0');
    expect(result.run_id).toBe(
      `AR-${timeHex.slice(0, 8)}-${timeHex.slice(8)}-71b2-83d4-e5f60718293a`,
    );
  });

  it('refuses an identity collision and preserves the first record byte for byte', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const input = options();
    const first = await withAuthorityHostTestScope(() => emitAgentRun(input));
    const path = join(getAgentRunDir(input.repoRoot), `${first.run_id}.json`);
    const bytes = readFileSync(path);
    await expect(withAuthorityHostTestScope(() => emitAgentRun(input))).rejects.toThrow(/EEXIST/u);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
