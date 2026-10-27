// Independent mutation checks for the narrowly scoped Git provisioning workflow.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const p = mkdtempSync(join(tmpdir(), 'minimal-workflow-'));
  roots.push(p);
  cpSync(join(root, '.github/workflows'), join(p, '.github/workflows'), { recursive: true });
  cpSync(join(root, '.github/actions'), join(p, '.github/actions'), { recursive: true });
  for (const file of ['.devai/config/toolchain.json', 'law/policy/credential-requirements.json']) {
    mkdirSync(join(p, file, '..'), { recursive: true });
    writeFileSync(join(p, file), readFileSync(join(root, file)));
  }
  return p;
}
describe('Git-only partition workflow review', () => {
  it('accepts the unmodified candidate', () => {
    expect(
      checkWorkflowTree(fixture()).findings.filter(
        (f: { file: string }) => f.file === 'pull-request-checks.yml',
      ),
    ).toEqual([]);
  });
  for (const job of ['gate-cli', 'gate-rest'])
    for (const mutation of ['omit-provision', 'omit-verify', 'optional', 'fallback', 'reorder']) {
      it(`rejects ${mutation} in ${job}`, () => {
        const p = fixture(),
          file = join(p, workflow),
          doc = parseDocument(readFileSync(file, 'utf8'));
        const steps = doc.getIn(['jobs', job, 'steps'], true) as {
          items: Array<{
            get: (key: string) => unknown;
            set: (key: string, value: unknown) => void;
          }>;
        };
        const provision = steps.items.findIndex((s) => s.get('id') === 'provision-git'),
          verify = steps.items.findIndex((s) => s.get('id') === 'verify-git');
        expect(provision).toBeGreaterThanOrEqual(0);
        expect(verify).toBeGreaterThanOrEqual(0);
        if (mutation === 'omit-provision') steps.items[provision].set('run', 'true');
        if (mutation === 'omit-verify') steps.items[verify].set('run', 'true');
        if (mutation === 'optional') steps.items[verify].set('continue-on-error', true);
        if (mutation === 'fallback')
          steps.items[verify].set('run', `${steps.items[verify].get('run')} || git --version`);
        if (mutation === 'reorder')
          [steps.items[provision], steps.items[verify]] = [
            steps.items[verify],
            steps.items[provision],
          ];
        writeFileSync(file, String(doc));
        const findings = checkWorkflowTree(p).findings.filter(
          (f: { file: string }) => f.file === 'pull-request-checks.yml',
        );
        expect(findings.map((f: { code: string }) => f.code)).toContain(
          'CI_PREFLIGHT_GATE_INVALID',
        );
      });
    }
  it('retains existing affected steps and artifact configuration byte-for-byte', () => {
    const baseline = spawnSync(
      'git',
      ['show', '47e71896:.github/workflows/pull-request-checks.yml'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(baseline.status).toBe(0);
    const old = parseDocument(baseline.stdout),
      current = parseDocument(readFileSync(join(root, workflow), 'utf8'));
    for (const job of ['gate-cli', 'gate-rest']) {
      for (const id of ['affected']) {
        const stepsOf = (doc: ReturnType<typeof parseDocument>) =>
          (
            doc.getIn(['jobs', job, 'steps'], true) as {
              items: Array<{ get: (key: string) => unknown }>;
            }
          ).items;
        expect(String(stepsOf(current).find((step) => step.get('id') === id))).toBe(
          String(stepsOf(old).find((step) => step.get('id') === id)),
        );
      }
    }
    for (const name of [
      'scripts/aggregate-gate-partitions.mjs',
      'scripts/process/summarize-check-report.mjs',
    ]) {
      const original = spawnSync('git', ['show', `47e71896:${name}`], { cwd: root });
      expect(original.status).toBe(0);
      expect(readFileSync(join(root, name))).toEqual(original.stdout);
    }
  });
});
