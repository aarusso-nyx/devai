// Build the CLI package first; this probe uses only a disposable fixture and never signs.
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { candidateResultsDirectory } from '../../scripts/process/release-prerequisites.mjs';

const work = mkdtempSync(join(tmpdir(), 'devai-rc-cache-integration-'));
const repo = join(work, 'repo');
const pkg = resolve('packages/cli');
const cli = join(pkg, 'dist/runtime/index/bin.js');
const host = join(pkg, 'dist/runtime/index/devai-rc-certification.js');
const exporter = join(pkg, 'dist/runtime/evidence-verification/src/export-cli.js');
const run = (command, args, cwd = repo) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      NO_COLOR: '1',
    },
  });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const put = (path, bytes) => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), bytes);
};
try {
  mkdirSync(repo);
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Fixture']);
  run('git', ['config', 'user.email', 'fixture@example.invalid']);
  run('git', ['config', 'core.hooksPath', '/dev/null']);
  put('package.json', '{"name":"fixture","private":true}\n');
  put('packages/cli/package.json', '{"name":"@aarusso-nyx/devai"}\n');
  put('scripts/process/release-prerequisites.mjs', '// disposable fixture\n');
  put('.gitignore', '.devai/state/\n');
  const task = {
    nodeId: 'test:coverage:rc',
    dependencies: [],
    argv: ['node', '-e', 'process.stdout.write("fixture pass")'],
    cwd: '.',
    runner: 'node-v1',
    inputSelectors: [{ kind: 'exact', pattern: 'package.json' }],
    toolchainKeys: [],
    allowlistedEnv: [],
    outputContract: { kind: 'test', requiredResult: 'pass' },
  };
  put(
    'test-tasks.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      descriptorVersion: 'fixture',
      repositoryId: 'aarusso-nyx/devai',
      fallbackNodeId: task.nodeId,
      dynamicFallbackSelectors: [],
      tasks: [task],
      profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: [task.nodeId] }],
    }),
  );
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ])
    run(process.execPath, [
      cli,
      'init',
      'bind',
      ...selector,
      '--target',
      '.',
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
  run('git', ['add', '-A']);
  run('git', ['commit', '-qm', 'fixture']);
  const prior = join(repo, '.devai/state/check-cache/v1/nodes/prior.json');
  mkdirSync(join(prior, '..'), { recursive: true });
  writeFileSync(prior, 'prior cache bytes');
  const output = JSON.parse(
    run(process.execPath, [host, repo, join(repo, 'scripts/process/release-prerequisites.mjs')]),
  );
  const report = output.result?.value ?? output;
  assert.equal(report.exitCode, 0);
  assert.equal(report.execution.length, 1);
  assert.equal(report.execution[0].disposition, 'executed');
  assert.equal(report.execution[0].outcome, 'PASS');
  assert.equal(readFileSync(prior, 'utf8'), 'prior cache bytes');
  const receipt = report.receipt.path;
  const results = candidateResultsDirectory(repo, receipt);
  assert.match(results, /rc-certification-[0-9a-f-]+\/results$/u);
  const secondOutput = JSON.parse(
    run(process.execPath, [host, repo, join(repo, 'scripts/process/release-prerequisites.mjs')]),
  );
  const second = secondOutput.result?.value ?? secondOutput;
  assert.equal(second.execution[0].disposition, 'executed');
  assert.equal(second.execution[0].outcome, 'PASS');
  assert.notEqual(candidateResultsDirectory(repo, second.receipt.path), results);
  assert.equal(readFileSync(prior, 'utf8'), 'prior cache bytes');
  const toolchain = join(work, 'toolchain.json');
  const environment = join(work, 'environment.json');
  const publicKey = join(work, 'public.pem');
  const out = join(work, 'export');
  writeFileSync(toolchain, '{}');
  writeFileSync(environment, '{}');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const commit = run('git', ['rev-parse', 'HEAD']);
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']);
  const verified = JSON.parse(
    run(process.execPath, [
      exporter,
      '--repo',
      repo,
      '--receipt',
      receipt,
      '--results-dir',
      results,
      '--profile',
      'rc',
      '--commit',
      commit,
      '--tree',
      tree,
      '--toolchain',
      toolchain,
      '--environment',
      environment,
      '--public-key',
      publicKey,
      '--signer-id',
      'fixture',
      '--output-dir',
      out,
      '--preflight',
      'true',
    ]),
  );
  assert.equal(verified.preflight, true);
  assert.equal(existsSync(out), false);
  console.log('Disposable governed RC cache and unsigned exporter preflight passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
