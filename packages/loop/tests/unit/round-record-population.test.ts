import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roundRecordIntegrity } from '../../src/governance-ledger/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-round-record-population-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('round record population boundaries', () => {
  it('returns a deterministic empty report when the rounds directory is absent', () => {
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });

  it('ignores non-directory entries while reporting directories without records', () => {
    write('work/rounds/README.txt', 'not a round directory\n');
    mkdirSync(join(root, 'work/rounds/R-0002'), { recursive: true });

    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ROUND_RECORD_MISSING',
          message: 'R-0002 has no record.md.',
          path: 'work/rounds/R-0002',
        },
      ],
    });
  });
});
