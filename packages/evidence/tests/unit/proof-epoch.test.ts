// Invariants: INV-DEVAI-016, INV-DEVAI-018
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import {
  appendProofEpochErrata,
  appendProofEpochRecord,
  closeProofEpoch,
  computeProofEpochLineHash,
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
  it.each([
    ['round', { round_id: 'R-0006' }, 'line 2 crosses round'],
    ['kind', { kind: 'other' }, 'line 2 crosses kind'],
    ['record count', { record_count: 0 }, 'line 2 has wrong record count'],
    ['terminal hash', { terminal_hash: '0'.repeat(64) }, 'line 2 has wrong terminal hash'],
  ] as const)('rejects a rehashed terminal with a wrong %s', (_name, changes, diagnostic) => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'seal' };
    const first = appendProofEpochRecord({ ...inputs, payload: { result: 'pass' } });
    const terminal = closeProofEpoch(inputs);
    const { line_hash: _hash, ...unsigned } = { ...terminal, ...changes };
    const forged = { ...unsigned, line_hash: computeProofEpochLineHash(unsigned) };
    write(proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind), [first, forged]);
    const result = verifyProofEpoch(inputs);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(diagnostic);
    expect(result.errors).not.toContain('line 2 has a tampered hash');
  });

  it('rejects a rehashed forward errata reference', () => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'errata' };
    const first = appendProofEpochRecord({ ...inputs, payload: {} });
    const errata = appendProofEpochErrata({
      ...inputs,
      payload: {},
      correctsSequence: 1,
      reason: 'correction',
    });
    const { line_hash: _hash, ...unsigned } = { ...errata, corrects_sequence: 2 };
    write(proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind), [
      first,
      { ...unsigned, line_hash: computeProofEpochLineHash(unsigned) },
    ]);
    expect(verifyProofEpoch({ ...inputs, requireClosed: false })).toMatchObject({
      valid: false,
      errors: ['line 2 has invalid forward or non-record errata'],
    });
  });

  it.each([
    { value: null },
    { value: false },
    { value: 42 },
    { value: 'invalid' },
    { value: [] },
    { value: {} },
  ])('reports malformed line $value without crashing or permitting append', ({ value }) => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'malformed' };
    appendProofEpochRecord({ ...inputs, payload: { initial: true } });
    const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    const bytes = readFileSync(path);
    const result = verifyProofEpoch({ ...inputs, requireClosed: false });
    expect(result).toMatchObject({ valid: false, closed: false, recordCount: 0 });
    expect(result.errors).toContain('line 1 fails schema validation');
    expect(() => appendProofEpochRecord({ ...inputs, payload: { late: true } })).toThrow(
      /proof epoch is invalid/u,
    );
    expect(readFileSync(path)).toEqual(bytes);
  });

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
