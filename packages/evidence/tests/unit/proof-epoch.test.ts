// Invariants: INV-DEVAI-016, INV-DEVAI-018
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('separates proof files by their exact round and kind', () => {
    const repoRoot = root();
    expect(proofEpochPath(repoRoot, 'R-0005', 'test-results')).toBe(
      join(repoRoot, 'record/proofs/work/test-results/R-0005.jsonl'),
    );
    expect(proofEpochPath(repoRoot, 'R-0006', 'test-results')).not.toBe(
      proofEpochPath(repoRoot, 'R-0005', 'test-results'),
    );
    expect(proofEpochPath(repoRoot, 'R-0005', 'lint')).not.toBe(
      proofEpochPath(repoRoot, 'R-0005', 'test-results'),
    );
  });

  it.each([null, [], false, 42, 'invalid'])(
    'refuses an invalid runtime payload %j before creating or appending proof bytes',
    (payload) => {
      const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'payload' };
      const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
      const invalid = payload as unknown as Readonly<Record<string, unknown>>;
      expect(() => appendProofEpochRecord({ ...inputs, payload: invalid })).toThrow(
        /proof epoch line does not validate:/u,
      );
      expect(existsSync(path)).toBe(false);
      appendProofEpochRecord({ ...inputs, payload: { valid: true } });
      const before = readFileSync(path);
      expect(() => appendProofEpochRecord({ ...inputs, payload: invalid })).toThrow(
        /proof epoch line does not validate:/u,
      );
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it.each(['earlier errata', 'later record'] as const)(
    'rejects a rehashed correction targeting an %s independently of hash integrity',
    (target) => {
      const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'references' };
      const first = appendProofEpochRecord({ ...inputs, payload: {} });
      const second = appendProofEpochErrata({
        ...inputs,
        payload: {},
        correctsSequence: 1,
        reason: 'first correction',
      });
      const third = appendProofEpochRecord({ ...inputs, payload: {} });
      const unsignedSecond = {
        ...second,
        corrects_sequence: target === 'later record' ? 3 : 1,
      };
      const { line_hash: _secondHash, ...secondBody } = unsignedSecond;
      const rewrittenSecond = { ...secondBody, line_hash: computeProofEpochLineHash(secondBody) };
      const thirdBody = {
        schemaVersion: third.schemaVersion,
        line_type: target === 'earlier errata' ? ('errata' as const) : ('record' as const),
        round_id: third.round_id,
        kind: third.kind,
        sequence: third.sequence,
        timestamp: third.timestamp,
        payload: third.payload,
        previous_line_hash: rewrittenSecond.line_hash,
        ...(target === 'earlier errata'
          ? { corrects_sequence: 2, reason: 'second correction' }
          : {}),
      };
      const rewrittenThird = { ...thirdBody, line_hash: computeProofEpochLineHash(thirdBody) };
      const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
      write(path, [first, rewrittenSecond, rewrittenThird]);
      const before = readFileSync(path);
      const result = verifyProofEpoch({ ...inputs, requireClosed: false });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        `line ${target === 'earlier errata' ? '3' : '2'} has invalid forward or non-record errata`,
      ]);
      expect(() => closeProofEpoch(inputs)).toThrow(/proof epoch is invalid/u);
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it('treats an existing zero-byte epoch as empty before the first append', () => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'empty-file' };
    appendProofEpochRecord({ ...inputs, payload: {} });
    const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
    writeFileSync(path, '');
    expect(verifyProofEpoch({ ...inputs, requireClosed: false })).toEqual({
      valid: true,
      closed: false,
      head: null,
      recordCount: 0,
      lines: [],
      errors: [],
    });
    expect(readFileSync(path)).toHaveLength(0);
    const first = appendProofEpochRecord({ ...inputs, payload: { fresh: true } });
    expect(first.sequence).toBe(1);
    expect(first.previous_line_hash).toBeNull();
    expect(parse(path)).toEqual([first]);
  });

  it('reports independent epoch identity defects together without appending', () => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'identity' };
    const first = appendProofEpochRecord({ ...inputs, payload: {} });
    const { line_hash: _hash, ...original } = first;
    const wrongIdentity = { ...original, round_id: 'R-0006', kind: 'foreign' };
    const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
    write(path, [{ ...wrongIdentity, line_hash: computeProofEpochLineHash(wrongIdentity) }]);
    const before = readFileSync(path);
    expect(verifyProofEpoch({ ...inputs, requireClosed: false }).errors).toEqual([
      'line 1 crosses round',
      'line 1 crosses kind',
    ]);
    expect(() => appendProofEpochRecord({ ...inputs, payload: {} })).toThrow(
      'proof epoch is invalid: line 1 crosses round; line 1 crosses kind',
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it('hashes nested object keys canonically while preserving array order and input bytes', () => {
    const unsigned = {
      schemaVersion: '1.0.0' as const,
      line_type: 'record' as const,
      round_id: 'R-0005',
      kind: 'hash',
      sequence: 1,
      timestamp: '2026-08-10T00:00:00.000Z',
      payload: { z: 0, a: [{ z: 2, a: 1 }, null] },
      previous_line_hash: null,
    };
    const original = JSON.stringify(unsigned);
    // Independent SHA-256 vector over recursively sorted, compact JSON.
    const expected = '147953a022e467c20359c1cd64d25e91f5a500fa1e7afa0e0e002b66ef721f8c';
    expect(computeProofEpochLineHash(unsigned)).toBe(expected);
    expect(
      computeProofEpochLineHash({ ...unsigned, payload: { a: [{ a: 1, z: 2 }, null], z: 0 } }),
    ).toBe(expected);
    expect(
      computeProofEpochLineHash({ ...unsigned, payload: { a: [null, { a: 1, z: 2 }], z: 0 } }),
    ).not.toBe(expected);
    expect(JSON.stringify(unsigned)).toBe(original);
  });

  it('seals an empty epoch with the dedicated empty hash and no phantom records', () => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'empty' };
    expect(verifyProofEpoch({ ...inputs, requireClosed: false })).toMatchObject({
      valid: true,
      closed: false,
      recordCount: 0,
      head: null,
    });
    expect(verifyProofEpoch(inputs).valid).toBe(false);
    const terminal = closeProofEpoch(inputs);
    expect(terminal).toMatchObject({
      sequence: 1,
      record_count: 0,
      payload: {},
      previous_line_hash: null,
      terminal_hash: 'd8340ed8a3ecd08c7e13e780a74e251073d1707951dcd8a41f476ac49258aa5f',
    });
    expect(verifyProofEpoch(inputs)).toMatchObject({
      valid: true,
      closed: true,
      recordCount: 0,
      head: terminal.line_hash,
    });
  });

  it.each(['R-005', 'R-00055', 'prefixR-0005', 'R-0005suffix', '../R-0005'])(
    'refuses malformed round identity %s',
    (roundId) => {
      expect(() => proofEpochPath(root(), roundId, 'valid')).toThrow(/invalid proof epoch round/u);
    },
  );
  it.each(['', '../escape', '/absolute', 'UPPER', 'valid/child', '_prefix'])(
    'refuses malformed kind %s',
    (kind) => {
      expect(() => proofEpochPath(root(), 'R-0005', kind)).toThrow(/invalid proof epoch kind/u);
    },
  );

  it.each([
    ['missing newline', '{}', /missing final newline/u],
    ['empty line', '\n', /empty line at 1/u],
    ['invalid JSON', '{\n', /invalid JSON at line 1/u],
  ] as const)('rejects %s and preserves the damaged epoch', (_label, bytes, diagnostic) => {
    const inputs = { repoRoot: root(), roundId: 'R-0005', kind: 'damaged' };
    appendProofEpochRecord({ ...inputs, payload: {} });
    const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
    writeFileSync(path, bytes);
    const result = verifyProofEpoch(inputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(diagnostic);
    expect(() => closeProofEpoch(inputs)).toThrow(diagnostic);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

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
