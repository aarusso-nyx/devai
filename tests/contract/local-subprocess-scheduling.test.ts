import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../..');

it('actually executes both native fixtures before portable and serial fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-local-scheduling-'));
  const trace = join(root, 'execution.jsonl');
  const reportPath = join(root, 'report.json');
  const configPath = join(root, 'vitest.config.mjs');
  const inputs: { path: string; sha256: string; bytes_base64: string }[] = [];
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const put = (path: string, text: string) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
    inputs.push({ path, sha256: sha(text), bytes_base64: Buffer.from(text).toString('base64') });
  };
  const testSource = (label: string, prerequisite: readonly string[]) => `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it(${JSON.stringify(label)}, () => {
  const path = ${JSON.stringify(trace)};
  const before = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
  for (const label of ${JSON.stringify(prerequisite)}) expect(before).toContain(label);
  appendFileSync(path, JSON.stringify(${JSON.stringify(label)}) + '\\n');
});
`;
  try {
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    put('package.json', '{"type":"module"}\n');
    const native = ['owner', 'provision'] as const;
    for (const label of native)
      put(
        `packages/authority/tests/unit/reconciliation-host-${label}.test.ts`,
        testSource(label, []),
      );
    put('packages/sensors/tests/unit/portable.test.ts', testSource('portable', native));
    put(
      'packages/cli/tests/unit/authority-policy-review.test.ts',
      testSource('serial', [...native, 'portable']),
    );
    put(
      'vitest.config.mjs',
      `import base from ${JSON.stringify(pathToFileURL(join(repository, 'tests/config/local.config.ts')).href)};\nexport default { ...base, root: ${JSON.stringify(root)} };\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repository, 'scripts/process/validation-runner.mjs'),
        '--',
        process.execPath,
        join(repository, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        configPath,
        '--configLoader',
        'runner',
        '--no-cache',
        '--reporter',
        'json',
        '--outputFile',
        reportPath,
      ],
      { cwd: repository, env: process.env, encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      testResults: { name: string }[];
    };
    console.info(
      'LOCAL_SCHEDULING_DISPATCH',
      JSON.stringify({
        node: process.versions.node,
        executable: process.execPath,
        config_sha256: sha(readFileSync(join(repository, 'tests/config/local.config.ts'))),
        inputs,
        exit: result.status,
        report,
      }),
    );
    expect(report.numPassedTests, JSON.stringify(report)).toBe(4);
    expect(report.numFailedTests).toBe(0);
    expect(report.numPendingTests).toBe(0);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(report.testResults).toHaveLength(4);
    const executed = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string);
    expect(executed.slice(0, 2).sort()).toEqual([...native].sort());
    expect(executed.slice(2)).toEqual(['portable', 'serial']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
