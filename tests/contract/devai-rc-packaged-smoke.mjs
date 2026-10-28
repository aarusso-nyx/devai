// Run after the CLI package build: node tests/contract/devai-rc-packaged-smoke.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'devai-rc-packaged-smoke-'));
try {
  const executable = resolve('packages/cli/dist/runtime/index/devai-rc-certification.js');
  const control = join(root, 'scripts/process/release-prerequisites.mjs');
  mkdirSync(join(root, 'scripts/process'), { recursive: true });
  mkdirSync(join(root, 'packages/cli'), { recursive: true });
  writeFileSync(control, '');
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const manifest = (name) =>
    writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({ name }));
  const descriptor = (repositoryId) =>
    writeFileSync(
      join(root, 'test-tasks.json'),
      JSON.stringify({ repositoryId, tasks: [{ nodeId: 'test:coverage:rc' }] }),
    );
  const run = (cwd, path = control) =>
    spawnSync(process.execPath, [executable, root, path], { cwd, encoding: 'utf8' });
  manifest('foreign/package');
  descriptor('foreign/repo');
  let result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RC_HOST_SOURCE_SCOPE_INVALID/u);
  manifest('@aarusso-nyx/devai');
  result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RC_HOST_SOURCE_SCOPE_INVALID/u);
  descriptor('aarusso-nyx/devai');
  result = run(tmpdir());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RC_HOST_SOURCE_SCOPE_INVALID/u);
  result = run(root, join(root, 'other'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RC_HOST_SOURCE_SCOPE_INVALID/u);
  result = run(root);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stderr);
  assert.equal(report.action_id, 'check');
  assert.equal(report.ok, false);
  assert.equal(report.error?.code, 'AUTHORITY_POLICY_MISSING');
  assert.equal(report.error?.context?.repository_root, root);
  console.log(
    'Packaged certification rejects foreign scope and preserves governed check authority.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
