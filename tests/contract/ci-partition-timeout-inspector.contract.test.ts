// Inspector tests for proposed ADR-CHK-0011 job budgets; this does not qualify hosted timing.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = '.github/workflows/pull-request-checks.yml';
const { checkWorkflowTree } = await import(
  pathToFileURL(join(root, 'scripts/check-workflows.mjs')).href
);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'partition-budget-'));
  roots.push(path);
  cpSync(join(root, '.github/workflows'), join(path, '.github/workflows'), { recursive: true });
  cpSync(join(root, '.github/actions'), join(path, '.github/actions'), { recursive: true });
  for (const file of ['.devai/config/toolchain.json', 'law/policy/credential-requirements.json']) {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), readFileSync(join(root, file)));
  }
  const file = join(path, workflow);
  const candidate = parseDocument(readFileSync(file, 'utf8'));
  candidate.setIn(['jobs', 'gate-cli', 'timeout-minutes'], 30);
  candidate.setIn(['jobs', 'gate-rest', 'timeout-minutes'], 30);
  writeFileSync(file, String(candidate));
  return path;
}
function findings(job: string, value: unknown) {
  const path = fixture(),
    file = join(path, workflow),
    document = parseDocument(readFileSync(file, 'utf8'));
  if (value === undefined) document.deleteIn(['jobs', job, 'timeout-minutes']);
  else document.setIn(['jobs', job, 'timeout-minutes'], value);
  writeFileSync(file, String(document));
  return checkWorkflowTree(path).findings.filter(
    (f: { file: string }) => f.file === 'pull-request-checks.yml',
  );
}
describe('proposed partition job budgets', () => {
  it('sets Linux and native jobs to 30 minutes and preserves the aggregate budget', () => {
    const doc = parseDocument(readFileSync(join(root, workflow), 'utf8'));
    expect(doc.getIn(['jobs', 'gate-cli', 'timeout-minutes'])).toBe(30);
    expect(doc.getIn(['jobs', 'gate-rest', 'timeout-minutes'])).toBe(30);
    expect(doc.getIn(['jobs', 'native-apfs', 'timeout-minutes'])).toBe(30);
    expect(doc.getIn(['jobs', 'gate', 'timeout-minutes'])).toBe(10);
  });
  it('accepts the clean proposed 30/30/30/10 baseline without findings', () => {
    const result = checkWorkflowTree(fixture());
    expect(
      result.findings.filter((f: { file: string }) => f.file === 'pull-request-checks.yml'),
    ).toEqual([]);
  });
  for (const [job, budget] of [
    ['gate-cli', 30],
    ['gate-rest', 30],
    ['native-apfs', 30],
    ['gate', 10],
  ] as const) {
    for (const invalid of [
      undefined,
      0,
      -1,
      1.5,
      budget - 1,
      budget + 1,
      String(budget),
      ...(job === 'native-apfs' ? [15] : []),
    ]) {
      it(`checker returns the timeout-specific finding for ${String(invalid)} in ${job}`, () => {
        const result = findings(job, invalid);
        expect(result).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'CI_PREFLIGHT_TIMEOUT_INVALID',
              file: 'pull-request-checks.yml',
              detail: expect.stringContaining(`jobs.${job}`),
            }),
          ]),
        );
      });
    }
  }
});
