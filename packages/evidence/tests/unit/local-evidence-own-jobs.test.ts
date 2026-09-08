import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, beforeEach, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { collectLocalEvidence } from '../../src/local-evidence/collect.js';

let root: string;
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-own-jobs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, data: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}
function policy(job: string): void {
  put(
    '.devai/config/project.json',
    JSON.stringify({ ci_economy: { local_evidence: { required_jobs: [job] } } }),
  );
}
function initialized(job: string): void {
  policy(job);
  put('package.json', '{"name":"fixture","engines":{"node":">=24"}}');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Inspector Fixture'],
    ['config', 'user.email', 'inspector@example.invalid'],
    ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ])
    execFileSync('git', args, { cwd: root });
  put(
    '.artifacts/job/metadata.txt',
    `job=${job}\nplatform=linux/amd64\nnode=${process.version}\n__proto__=literal metadata\n`,
  );
}

it.each(['constructor', '__proto__', 'toString'])(
  'requires an own artifact directory for job %s',
  (job) => {
    policy(job);
    expect(() => collectLocalEvidence({ repoRoot: root, jobDirs: {} })).toThrow(
      `missing artifact directory for required job: ${job}`,
    );
    expect(existsSync(join(root, 'record'))).toBe(false);
  },
);

it.each(['constructor', '__proto__', 'toString'])(
  'retains an explicitly supplied job named %s as an own manifest entry',
  (job) => {
    initialized(job);
    const dirs = Object.fromEntries([[job, '.artifacts/job']]);
    const result = collectLocalEvidence({
      repoRoot: root,
      jobDirs: dirs,
      now: new Date('2026-09-08T09:00:00.000Z'),
    });
    expect(Object.keys(result.manifest.jobs)).toEqual([job]);
    expect(Object.hasOwn(result.manifest.jobs, job)).toBe(true);
    expect(result.manifest.jobs[job]?.metadata['job']).toBe(job);
    expect(result.manifest.jobs[job]?.metadata['__proto__']).toBe('literal metadata');
    const persisted = JSON.parse(
      readFileSync(join(root, result.outputPath), 'utf8'),
    ) as typeof result.manifest;
    expect(Object.keys(persisted.jobs)).toEqual([job]);
    expect(persisted.jobs[job]?.metadata['__proto__']).toBe('literal metadata');
  },
);
