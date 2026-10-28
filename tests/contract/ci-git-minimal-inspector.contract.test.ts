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
        if (!steps.items[provision] || !steps.items[verify]) throw Error('missing Git step');
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
  for (const job of ['gate-cli', 'gate-rest'])
    for (const phase of job === 'gate-rest' ? ['preflight', 'affected'] : ['preflight'])
      for (const mutation of ['missing', 'softened', 'moved']) {
        it(`rejects ${mutation} ${phase} recheck in ${job}`, () => {
          const p = fixture(),
            file = join(p, workflow),
            doc = parseDocument(readFileSync(file, 'utf8'));
          const steps = doc.getIn(['jobs', job, 'steps'], true) as {
            items: Array<{
              get: (key: string) => unknown;
              set: (key: string, value: unknown) => void;
            }>;
          };
          const step = steps.items.find((s) => s.get('id') === phase);
          if (!step) throw Error('missing phase');
          const verify = 'node scripts/process/ci-partition/integrated.mjs verify';
          const run = String(step.get('run'));
          expect(run).toContain(verify);
          let changed: string;
          if (mutation === 'missing') changed = run.replace(`${verify}\n`, '');
          else if (mutation === 'softened') changed = run.replace(verify, `${verify} || true`);
          else changed = run.replace(`${verify}\n`, '') + `\n${verify}\n`;
          step.set('run', changed);
          writeFileSync(file, String(doc));
          const findings = checkWorkflowTree(p).findings.filter(
            (f: { file: string }) => f.file === 'pull-request-checks.yml',
          );
          expect(findings.map((f: { code: string }) => f.code)).toContain(
            'CI_PREFLIGHT_GATE_INVALID',
          );
        });
      }
  for (const job of ['gate-cli', 'gate-rest'])
    for (const mutation of ['missing', 'softened', 'moved']) {
      it(`rejects ${mutation} pre-affected verification step in ${job}`, () => {
        const p = fixture(),
          file = join(p, workflow),
          doc = parseDocument(readFileSync(file, 'utf8'));
        const steps = doc.getIn(['jobs', job, 'steps'], true) as {
          items: Array<{
            get: (key: string) => unknown;
            set: (key: string, value: unknown) => void;
          }>;
        };
        const i = steps.items.findIndex((s) => s.get('id') === 'verify-affected-git');
        const j = steps.items.findIndex((s) => s.get('id') === 'affected');
        expect(i).toBeGreaterThanOrEqual(0);
        expect(j).toBeGreaterThanOrEqual(0);
        if (!steps.items[i] || !steps.items[j]) throw Error('missing verification step');
        if (mutation === 'missing') steps.items[i].set('run', 'true');
        if (mutation === 'softened') steps.items[i].set('continue-on-error', true);
        if (mutation === 'moved')
          [steps.items[i], steps.items[j]] = [steps.items[j], steps.items[i]];
        writeFileSync(file, String(doc));
        const findings = checkWorkflowTree(p).findings.filter(
          (f: { file: string }) => f.file === 'pull-request-checks.yml',
        );
        expect(findings.map((f: { code: string }) => f.code)).toContain(
          'CI_PREFLIGHT_GATE_INVALID',
        );
      });
    }
  it('preserves each original affected step except for the exact required Git rechecks', () => {
    // This mainline ancestor has the same baseline blobs as the original review commit.
    const baselineCommit = '6805553f0790ebfed8b39b96b01710d2d8752e47';
    const baseline = spawnSync(
      'git',
      ['show', `${baselineCommit}:.github/workflows/pull-request-checks.yml`],
      { cwd: root, encoding: 'utf8' },
    );
    expect(baseline.status).toBe(0);
    const old = parseDocument(baseline.stdout),
      current = parseDocument(readFileSync(join(root, workflow), 'utf8'));
    for (const job of ['gate-cli', 'gate-rest']) {
      const stepsOf = (doc: ReturnType<typeof parseDocument>) =>
        (
          doc.getIn(['jobs', job, 'steps'], true) as {
            items: Array<{ get: (key: string) => unknown; toJSON: () => Record<string, unknown> }>;
          }
        ).items;
      const before = stepsOf(old)
        .find((step) => step.get('id') === 'affected')
        ?.toJSON();
      const after = stepsOf(current)
        .find((step) => step.get('id') === 'affected')
        ?.toJSON();
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (!before || !after) throw Error('missing affected step');
      const lines = String(after.run).split('\n');
      const verify = 'node scripts/process/ci-partition/integrated.mjs verify';
      expect(lines.filter((line) => line === verify)).toHaveLength(job === 'gate-rest' ? 1 : 0);
      expect(lines.filter((line) => line !== verify).join('\n')).toBe(before.run);
      const withoutRun = (step: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'run'));
      expect(withoutRun(after)).toEqual(withoutRun(before));
      const affected = lines.findIndex((line) => line.includes('check --affected --run'));
      if (job === 'gate-rest') {
        const release = lines.findIndex((line) => line.includes('pnpm run release:pr-gate'));
        expect(lines[release + 1]).toBe(verify);
        expect(release).toBeLessThan(affected);
      }
    }
    for (const name of [
      'scripts/aggregate-gate-partitions.mjs',
      'scripts/process/summarize-check-report.mjs',
    ]) {
      const original = spawnSync('git', ['show', `${baselineCommit}:${name}`], { cwd: root });
      expect(original.status).toBe(0);
      expect(readFileSync(join(root, name))).toEqual(original.stdout);
    }
  });
});
