import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecRobustnessTargets } from '../../src/spec-robustness-targets.js';

const now = '2026-09-09T12:00:00.000Z';
let root: string;

function write(path: string, contents: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-robustness-idempotent-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec robustness idempotency statements', () => {
  it.each(['idempotent', 'IDEMPOTENT', 'idempot'])(
    'counts %s while rejecting containing words',
    (term) => {
      write(
        'law/invariants/idempotent.json',
        JSON.stringify({
          id: 'INV-IDEMPOTENT',
          type: 'data_contract',
          statement: `Writes are ${term}.`,
        }),
      );
      write(
        'law/invariants/nonmatching.json',
        JSON.stringify({
          id: 'INV-NONMATCHING',
          type: 'data_contract',
          statement: 'Writes are nonidempotent in the legacy adapter.',
        }),
      );
      write('docs/reference/contracts/errors.json', '{}');
      write('docs/reference/contracts/ordinary.md', '# Ordinary prose\n');

      const reading = senseSpecRobustnessTargets({ repoRoot: root, now });

      expect(reading.status).toBe('pass');
      expect(reading.findings).toEqual([]);
      expect(reading.metrics).toEqual({
        error_semantics_invariants: 1,
        error_contract_files: 1,
        targets_total: 2,
      });
    },
  );
});
