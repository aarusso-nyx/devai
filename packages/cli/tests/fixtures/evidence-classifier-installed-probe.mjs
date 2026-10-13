// Invariants: INV-DEVAI-001, INV-DEVAI-002, INV-DEVAI-012
// Explicit installed-archive rehearsal; invokes only the installed public CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [packageArgument, tarballArgument, outputArgument] = process.argv.slice(2);
assert(
  packageArgument && tarballArgument && outputArgument,
  'usage: node probe.mjs <installed-package-root> <exact-tarball> <output.json>',
);
const installed = realpathSync(packageArgument);
const archive = realpathSync(tarballArgument);
const output = resolve(outputArgument);
const workspace = mkdtempSync(join(tmpdir(), 'devai installed classifier ç '));
const adopter = join(workspace, 'adopter');
const reference = join(workspace, 'reference');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const observations = [];

function write(path, value) {
  const target = join(adopter, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}
function git(...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Classifier fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd: adopter, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
function files(root, prefix = '') {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      if (name === 'node_modules') return [];
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(join(root, path));
      assert(!stat.isSymbolicLink(), `payload link refused: ${path}`);
      return stat.isDirectory()
        ? files(root, path)
        : [{ path, sha256: digest(readFileSync(join(root, path))) }];
    });
}
function cli(args, status = 0) {
  const result = spawnSync(
    process.execPath,
    [join(installed, 'dist/runtime/index/bin.js'), ...args, '--format', 'json'],
    { cwd: adopter, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } },
  );
  if (status === 'nonzero') assert.notEqual(result.status, 0, 'premature execution must refuse');
  else if (status !== 'any')
    assert.equal(result.status, status, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  const envelopes = [result.stdout, result.stderr]
    .filter((stream) => stream.trim())
    .map((stream) => JSON.parse(stream));
  const action = args[0] === 'doctor' ? 'doctor' : args.slice(0, 2).join(' ');
  const envelope = envelopes.find((value) => value.action_id === action);
  assert(envelope, 'structured action envelope must be present on stdout or stderr');
  const payload = envelope.ok ? envelope.result.value : envelope.error.context.payload;
  observations.push({ args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
  return { envelope, payload, stdout: result.stdout, stderr: result.stderr };
}
function sense(kind, status = 0) {
  const result = cli(['sense', 'run', kind, '--repo-root', '.'], status);
  const member = result.payload.results.find(
    (entry) => entry.command === `devai sense run ${kind}`,
  );
  assert(member, `actual ${kind} reading missing`);
  return { ...result, reading: JSON.parse(member.stdout) };
}

try {
  mkdirSync(adopter);
  mkdirSync(reference);
  execFileSync('tar', ['-xzf', archive, '-C', reference]);
  const roster = files(join(reference, 'package'));
  assert.deepEqual(
    files(installed),
    roster,
    'installed bytes must equal the exact archive payload',
  );
  checks.push('installed archive byte parity');
  write(
    'package.json',
    JSON.stringify({ name: 'classifier-adopter', private: true, type: 'module' }),
  );
  write('.gitignore', 'node_modules/\n.devai/state/\n');
  git('init', '--quiet');
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    cli(['init', 'bind', ...selector, '--target', '.', '--as-role', 'architect', '--write']);
  }
  const targets = [
    'reference/api/test/e2e/flows/auth-and-permissions.e2e.ts',
    'reference/api/test/e2e/flows/privacy.e2e.ts',
    'packages/offline-sync/test/wiring/ctg9-http.wiring-spec.ts',
    'reference/api/test/e2e/flows/flow-design-and-runtime.e2e.ts',
    'reference/api/test/e2e/flows/flow-design-and-runtime.e2e.ts',
    'reference/api/test/e2e/flows/readonly-write-rollback.e2e.ts',
    'reference/api/test/e2e/flows/tenancy.e2e.ts',
    'tests/ação com espaço.wiring-spec.tsx',
  ];
  for (const path of targets) write(path, 'export {};\n');
  write('law/invariants/INV-PROBE-001.json', '{}\n');
  const trace = { invariants: [{ id: 'INV-PROBE-001', tests: targets.map((path) => ({ path })) }] };
  write('law/trace.json', `${JSON.stringify(trace)}\n`);
  git('add', '--all');
  git('commit', '--quiet', '-m', 'fixture');
  const valid = sense('trace_resolution');
  assert.equal(valid.reading.status, 'pass');
  assert.equal(valid.reading.metrics.missing_test_paths, 0);
  assert.deepEqual(valid.reading.findings, []);
  checks.push('seven unchanged STYNX trace links plus a Unicode TSX target resolve');

  trace.invariants[0].tests.push({ path: 'tests/missing.e2e.ts' });
  write('law/trace.json', `${JSON.stringify(trace)}\n`);
  const invalid = sense('trace_resolution', 3);
  assert.equal(invalid.stdout, '', 'gate failure must not be mistaken for empty success');
  assert.equal(invalid.envelope.error.code, 'ACTION_GATE_FAILED');
  assert.equal(invalid.reading.status, 'fail');
  assert.equal(invalid.reading.metrics.missing_test_paths, 1);
  assert(invalid.reading.findings.some((finding) => finding.code === 'invalid_test_path'));
  checks.push('failed gate reading retained through stderr error.context.payload');

  rmSync(join(adopter, 'packages'), { recursive: true });
  write('packages/contracts/src/contract.ts', 'export const contract = 1;\n');
  write(
    'packages/contracts/test/contracts.test.mjs',
    "import test from 'node:test'; test('contract', () => {});\n",
  );
  write('packages/unit/src/unit.ts', 'export const unit = 1;\n');
  write('packages/unit/test/unit.spec.ts', "import { it } from 'vitest'; it('unit', () => {});\n");
  const separated = sense('test_coherence');
  assert.equal(separated.reading.status, 'pass');
  assert.equal(separated.reading.metrics.naming_consistent, 1);
  assert.equal(separated.reading.metrics.test_files, 2);
  checks.push('actual Node/Vitest families permit independent naming');
  write(
    'packages/contracts/test/contracts.test.mjs',
    "import { it } from 'vitest'; it('contract', () => {});\n",
  );
  const mixed = sense('test_coherence', 1);
  assert.equal(mixed.reading.status, 'review');
  assert.equal(mixed.reading.metrics.naming_consistent, 0);
  assert(mixed.reading.findings.some((finding) => finding.code === 'TEST_COHERENCE_NAMING_MIXED'));
  checks.push('same-family mixed naming remains review');

  write('src/input.txt', 'measured source\n');
  const task = {
    nodeId: 'measure',
    sensorKinds: ['type_check'],
    dependencies: ['doctor'],
    cwd: '.',
    runner: 'exec-v1',
    argv: ['node', '-e', "require('node:fs').writeFileSync('SHOULD_NOT_EXECUTE','bad')"],
    inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
    toolchainKeys: ['pnpm', 'git'],
    allowlistedEnv: [],
    outputContract: { population: 'inspector-runtime-population' },
  };
  const doctorTask = {
    ...task,
    nodeId: 'doctor',
    dependencies: [],
    argv: ['node', '-e', 'process.exit(0)'],
  };
  delete doctorTask.sensorKinds;
  write(
    'test-tasks.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      descriptorVersion: 'installed-inspector-1',
      repositoryId: 'installed-inspector',
      fallbackNodeId: 'measure',
      dynamicFallbackSelectors: [],
      profiles: [],
      tasks: [doctorTask, task],
    }),
  );
  write(
    '.devai/config/sensor-inputs.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      inputs: { type_check: { taskId: 'measure', population: 'inspector-runtime-population' } },
    }),
  );
  git('add', '--all');
  git('commit', '--quiet', '-m', 'task contract');
  const declared = cli(['doctor', '--repo-root', '.', '--skip', 'docs-governance'], 'any');
  const readiness = declared.payload.checks.find(
    (check) => check.name === 'adopter-execution-readiness',
  );
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.equal(readiness.info.status, 'pass');
  assert.equal(readiness.info.standing, 'diagnostic-only');
  assert(readiness.info.bindings.every((binding) => binding.readinessScope === 'declaration-plan'));
  checks.push('Doctor declaration compatibility passes before prerequisite execution');
  const dry = cli([
    'sense',
    'run',
    'type_check',
    '--repo-root',
    '.',
    '--dry-run',
    '--as-role',
    'inspector',
    '--write',
  ]);
  assert.equal(dry.payload.authority.code, 'POLICY_ALLOW');
  assert.equal(dry.payload.authority.readiness_eligible, false);
  assert.equal(dry.payload.applied, false);
  checks.push('pre-authority pnpm/git task reference dry run passes without execution');
  const premature = cli(
    ['sense', 'run', 'type_check', '--repo-root', '.', '--as-role', 'inspector', '--write'],
    'nonzero',
  );
  assert.match(premature.stderr + premature.stdout, /SENSE_TASK_PREREQUISITE_REQUIRED/u);
  assert(!readdirSync(adopter).includes('SHOULD_NOT_EXECUTE'));
  assert(!existsSync(join(adopter, '.devai/state/check-cache')));
  checks.push('actual runtime refuses missing prerequisite evidence without running the task');
  writeFileSync(
    output,
    `${JSON.stringify({ status: 'PASS', installed, archive, archiveSha256: digest(readFileSync(archive)), manifest: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')), payloadFiles: roster.length, payloadRosterSha256: digest(JSON.stringify(roster)), checks, observations }, null, 2)}\n`,
  );
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, output }) + '\n');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
