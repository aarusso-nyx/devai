import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecRobustnessTargets } from '../../src/spec-robustness-targets.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

function write(path: string, value: unknown): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-robustness-population-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec robustness target population', () => {
  it('counts concrete robustness statements and matching error contracts only', () => {
    write('law/invariants/error-semantics.json', {
      id: 'INV-ERROR-SEMANTICS',
      type: 'error_semantics',
      statement: 'Missing resources return a stable error code.',
    });
    write('law/invariants/retry-contract.json', {
      id: 'INV-RETRY-CONTRACT',
      type: 'data_contract',
      statement: 'Writes are safe under retry after a transient failure.',
    });
    write('law/invariants/nonmatching-contract.json', {
      id: 'INV-NONMATCHING',
      type: 'data_contract',
      statement: 'A successful read returns the requested representation.',
    });
    write('law/invariants/ui-label.json', {
      id: 'INV-UI-LABEL',
      type: 'ui_behavior',
      statement: 'The retry button uses the secondary visual style.',
    });
    write('law/invariants/nonstring-statement.json', {
      id: 'INV-NONSTRING',
      type: 'data_contract',
      statement: ['retry'],
    });
    write('law/invariants/invalid.json', '{not-json');
    write('docs/reference/contracts/errors.json', { missing: 'MISSING_RESOURCE' });
    write('docs/reference/contracts/README.md', '# Not an error contract\n');
    write('docs/reference/contracts/ordinary.md', '# Not an error contract\n');

    const reading = senseSpecRobustnessTargets({ repoRoot: root, now });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      error_semantics_invariants: 2,
      error_contract_files: 1,
      targets_total: 3,
    });
  });
});
