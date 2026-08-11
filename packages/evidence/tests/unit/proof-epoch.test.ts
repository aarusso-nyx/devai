// Invariants: INV-DEVAI-016, INV-DEVAI-018
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import {
  appendProofEpochErrata,
  appendProofEpochRecord,
  closeProofEpoch,
  proofEpochPath,
  verifyProofEpoch,
  type ProofEpochLine,
} from '../../src/evidence/proof-epoch.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-proof-epoch-'));
  roots.push(path);
  return path;
}

function parse(path: string): ProofEpochLine[] {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ProofEpochLine);
}

function write(path: string, lines: readonly ProofEpochLine[]): void {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function lineAt(lines: readonly ProofEpochLine[], index: number): ProofEpochLine {
  const line = lines[index];
  if (line === undefined) throw new Error(`proof epoch fixture line ${String(index)} is missing`);
  return line;
}

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('proof epoch integrity', () => {
  it('appends records and forward-only errata before a terminal seal', () => {
    const repoRoot = root();
    const inputs = { repoRoot, roundId: 'R-0005', kind: 'test-results' } as const;

    appendProofEpochRecord({ ...inputs, payload: { result: 'red' } });
    appendProofEpochRecord({ ...inputs, payload: { result: 'green' } });
    appendProofEpochErrata({
      ...inputs,
      payload: { result: 'invalidated' },
      correctsSequence: 1,
      reason: 'superseded by the bounded repair',
    });
    closeProofEpoch({ ...inputs, payload: { disposition: 'closed' } });

    const result = verifyProofEpoch(inputs);
    expect(result).toMatchObject({ valid: true, closed: true, recordCount: 3 });
    expect(result.lines.map((line) => line.line_type)).toEqual([
      'record',
      'record',
      'errata',
      'terminal',
    ]);
    expect(() => appendProofEpochRecord({ ...inputs, payload: { result: 'late' } })).toThrow(
      /post-terminal data is forbidden/,
    );
  });

  it('rejects invalid errata targets', () => {
    const repoRoot = root();
    const inputs = { repoRoot, roundId: 'R-0005', kind: 'coverage' } as const;
    appendProofEpochRecord({ ...inputs, payload: { result: 'baseline' } });

    expect(() =>
      appendProofEpochErrata({
        ...inputs,
        payload: {},
        correctsSequence: 2,
        reason: 'forward target',
      }),
    ).toThrow(/earlier record/);
    expect(() =>
      appendProofEpochErrata({
        ...inputs,
        payload: {},
        correctsSequence: 1,
        reason: '   ',
      }),
    ).toThrow(/requires a reason/);
  });

  it('detects mutation, reordering, truncation, and duplicate terminal data', () => {
    const repoRoot = root();
    const inputs = { repoRoot, roundId: 'R-0005', kind: 'lint' } as const;
    appendProofEpochRecord({ ...inputs, payload: { ordinal: 1 } });
    appendProofEpochRecord({ ...inputs, payload: { ordinal: 2 } });
    closeProofEpoch(inputs);
    const path = proofEpochPath(repoRoot, inputs.roundId, inputs.kind);
    const original = parse(path);
    const first = lineAt(original, 0);
    const second = lineAt(original, 1);
    const terminal = lineAt(original, 2);

    const tampered = structuredClone(original);
    tampered[0] = { ...first, payload: { ordinal: 99 } };
    write(path, tampered);
    expect(verifyProofEpoch(inputs).errors).toContain('line 1 has a tampered hash');

    write(path, [second, first, terminal]);
    expect(verifyProofEpoch(inputs).errors).toEqual(
      expect.arrayContaining([
        'line 1 has reordered sequence',
        'line 1 has broken chain',
        'line 2 has reordered sequence',
      ]),
    );

    write(path, original.slice(0, -1));
    expect(verifyProofEpoch(inputs)).toMatchObject({ valid: false, closed: false });
    expect(verifyProofEpoch(inputs).errors).toContain('proof epoch is missing its terminal line');

    write(path, [...original, terminal]);
    expect(verifyProofEpoch(inputs).errors).toEqual(
      expect.arrayContaining([
        'line 3 has post-terminal data',
        'line 4 has reordered sequence',
        'proof epoch has duplicate terminals',
      ]),
    );
  });
});
