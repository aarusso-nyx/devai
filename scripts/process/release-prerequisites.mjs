#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const publicPem = (key) => createPublicKey(key).export({ type: 'spki', format: 'pem' });
const minimalEnvironment = () =>
  Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
function command(argv, cwd, env = minimalEnvironment(), trimOutput = true) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  requireValue(result.status === 0, 'CONTROL_COMMAND_FAILED');
  return trimOutput ? result.stdout.trim() : result.stdout;
}
function external(repo, path) {
  const actual = realpathSync(path);
  const rel = relative(repo, actual);
  requireValue(
    rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel),
    'PROTECTED_INPUT_INSIDE_CANDIDATE',
  );
  return actual;
}
function regular(path) {
  requireValue(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    'CONTROL_FILE_INVALID',
  );
  return readFileSync(path);
}

export function walkPackage(directory, root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    requireValue(
      !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
      'PACKAGE_FILE_INVALID',
    );
    return entry.isDirectory()
      ? walkPackage(path, root)
      : [relative(root, path).split(sep).join('/')];
  });
}

export function inspectPrerequisites(config, configPath) {
  const checks = [];
  const bindings = {};
  const attempt = (id, dependencies, operation) => {
    if (dependencies.some((id) => checks.find((check) => check.id === id)?.status !== 'pass')) {
      checks.push({ id, status: 'blocked', code: 'DEPENDENCY_NOT_PASS' });
      return;
    }
    try {
      operation();
      checks.push({ id, status: 'pass' });
    } catch {
      checks.push({ id, status: 'fail', code: `${id.toUpperCase().replaceAll('-', '_')}_INVALID` });
    }
  };
  let repo, verifier, packageManifest, descriptor;
  attempt('candidate', [], () => {
    repo = realpathSync(config.repo);
    bindings.commit = command(['git', 'rev-parse', 'HEAD'], repo);
    bindings.tree = command(['git', 'rev-parse', 'HEAD^{tree}'], repo);
    requireValue(
      command(['git', 'status', '--porcelain', '--untracked-files=all'], repo) === '',
      'CANDIDATE_DIRTY',
    );
    // NUL-delimited config preserves embedded/trailing whitespace and exposes
    // multiple origin entries. Do not accept arbitrary hosts with the same suffix.
    const configured = command(
      ['git', 'config', '--null', '--get-all', 'remote.origin.url'],
      repo,
      minimalEnvironment(),
      false,
    );
    requireValue(configured.endsWith('\0'), 'REPOSITORY_INVALID');
    const origin = configured.slice(0, -1);
    const approvedOrigins = new Set([
      'https://github.com/aarusso-nyx/devai',
      'https://github.com/aarusso-nyx/devai.git',
      'git@github.com:aarusso-nyx/devai',
      'git@github.com:aarusso-nyx/devai.git',
      'ssh://git@github.com/aarusso-nyx/devai',
      'ssh://git@github.com/aarusso-nyx/devai.git',
    ]);
    requireValue(
      approvedOrigins.has(origin) &&
        command(['git', 'remote', 'get-url', 'origin'], repo) === origin,
      'REPOSITORY_INVALID',
    );
    bindings.repositoryOrigin = origin;
    descriptor = read(join(repo, 'test-tasks.json'));
    bindings.descriptor = sha(regular(join(repo, 'test-tasks.json')));
  });
  attempt('control-location', [], () => {
    external(repo, configPath);
    bindings.config = sha(regular(configPath));
  });
  attempt('package', ['control-location'], () => {
    external(repo, config.packageRoot);
    packageManifest = read(join(config.packageRoot, 'package.json'));
    requireValue(packageManifest.name === '@aarusso-nyx/devai', 'PACKAGE_NAME_INVALID');
    requireValue(packageManifest.version === config.packageVersion, 'PACKAGE_VERSION_INVALID');
    verifier = join(config.packageRoot, 'dist/runtime/evidence-verification');
    const provenance = regular(join(verifier, 'provenance.json'));
    requireValue(sha(provenance) === config.verifierProvenanceSha256, 'PROVENANCE_INVALID');
    const listed = new Map(JSON.parse(provenance).files.map((file) => [file.path, file.sha256]));
    const walk = (directory) =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        requireValue(
          !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
          'SPECIAL_FILE_INVALID',
        );
        return entry.isDirectory() ? walk(path) : [relative(verifier, path).split(sep).join('/')];
      });
    requireValue(
      JSON.stringify(
        walk(verifier)
          .filter((name) => name !== 'provenance.json')
          .sort(),
      ) === JSON.stringify([...listed.keys()].sort()),
      'POPULATION_INVALID',
    );
    for (const [name, expected] of listed)
      requireValue(sha(regular(join(verifier, name))) === expected, 'PAYLOAD_INVALID');
    for (const [name, entry] of Object.entries({
      'devai-evidence-policy': 'build-policy-cli.js',
      'devai-evidence-export': 'export-cli.js',
      'devai-evidence-verify': 'cli.js',
    })) {
      requireValue(
        packageManifest.bin[name] === `./dist/runtime/evidence-verification/src/${entry}`,
        'BINARY_INVALID',
      );
    }
    const packageFiles = [
      'package.json',
      ...walkPackage(join(config.packageRoot, 'dist'), config.packageRoot),
    ];
    const packageTree = sha(
      JSON.stringify(
        packageFiles.sort().map((name) => [name, sha(regular(join(config.packageRoot, name)))]),
      ),
    );
    requireValue(packageTree === config.packageTreeSha256, 'INSTALLED_PACKAGE_TREE_INVALID');
    bindings.packageTree = packageTree;
    bindings.packageVersion = packageManifest.version;
    bindings.verifier = config.verifierProvenanceSha256;
  });
  attempt('maps', ['control-location'], () => {
    external(repo, config.toolchain);
    external(repo, config.environment);
    const toolchain = read(config.toolchain),
      environment = read(config.environment);
    requireValue(
      toolchain && environment && !Array.isArray(toolchain) && !Array.isArray(environment),
      'MAP_INVALID',
    );
    requireValue(
      Object.values(toolchain).every((value) => typeof value === 'string'),
      'TOOLCHAIN_INVALID',
    );
    requireValue(
      Object.values(environment).every((value) => value === null || typeof value === 'string'),
      'ENVIRONMENT_INVALID',
    );
    bindings.toolchain = sha(regular(config.toolchain));
    bindings.environment = sha(regular(config.environment));
  });
  attempt('signer', ['control-location'], () => {
    for (const name of ['privateKey', 'publicKey', 'trustStore']) external(repo, config[name]);
    const privateKey = createPrivateKey(regular(config.privateKey));
    requireValue(privateKey.asymmetricKeyType === 'ed25519', 'KEY_TYPE_INVALID');
    const publicKey = createPublicKey(regular(config.publicKey)).export({
      type: 'spki',
      format: 'pem',
    });
    requireValue(publicPem(privateKey) === publicKey, 'KEY_PAIR_INVALID');
    const trust = read(config.trustStore);
    const signer = trust.trustedSigners.find((signer) => signer.signerId === config.signerId);
    requireValue(signer && !trust.revokedSignerIds.includes(config.signerId), 'SIGNER_UNTRUSTED');
    requireValue(
      createPublicKey(signer.publicKeyPem).export({ type: 'spki', format: 'pem' }) === publicKey,
      'TRUST_KEY_INVALID',
    );
    bindings.signer = sha(publicKey);
    bindings.trust = sha(regular(config.trustStore));
  });
  attempt('destination', [], () => {
    requireValue(!existsSync(config.outputDir), 'OUTPUT_EXISTS');
    const parent = external(repo, dirname(resolve(config.outputDir)));
    accessSync(parent, constants.W_OK | constants.X_OK);
    bindings.destination = join(parent, config.outputDir.split(sep).at(-1));
  });
  attempt('policy', ['candidate', 'package', 'maps'], () => {
    const temporary = mkdtempSync(join(tmpdir(), 'devai-prerequisites-'));
    try {
      const output = command(
        [
          process.execPath,
          join(verifier, 'src/build-policy-cli.js'),
          '--repo',
          repo,
          '--descriptor',
          join(repo, 'test-tasks.json'),
          '--profile',
          'rc',
          '--schema-version',
          '1.1.0',
          '--commit',
          bindings.commit,
          '--tree',
          bindings.tree,
          '--toolchain',
          config.toolchain,
          '--environment',
          config.environment,
          '--output',
          join(temporary, 'policy.json'),
        ],
        temporary,
      );
      bindings.policy = JSON.parse(output).taskPolicyDigest;
      requireValue(bindings.policy === config.policyDigest, 'POLICY_DIGEST_INVALID');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  return {
    schemaVersion: '1.0.0',
    phase: 'prerequisites',
    ok: checks.every((check) => check.status === 'pass'),
    checks,
    bindings,
    descriptor,
  };
}

export function assertFresh(prior, current) {
  requireValue(
    prior.schemaVersion === '1.0.0' &&
      prior.phase === 'prerequisites' &&
      prior.ok === true &&
      current.ok === true &&
      canonical(prior.bindings) === canonical(current.bindings),
    'PREREQUISITES_STALE_OR_FAILED',
  );
}

/** Runtime values remain private; only their preapproved identities enter evidence. */
export function certificationEnvironment(config, descriptor) {
  requireValue(typeof config.runtimeEnvironment === 'string', 'RUNTIME_ENVIRONMENT_REQUIRED');
  external(realpathSync(config.repo), config.runtimeEnvironment);
  requireValue(
    realpathSync(config.runtimeEnvironment) !== realpathSync(config.environment),
    'RUNTIME_ENVIRONMENT_SEPARATE_FILE_REQUIRED',
  );
  const stat = lstatSync(config.runtimeEnvironment);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    'RUNTIME_ENVIRONMENT_FILE_INVALID',
  );
  let values, identities;
  try {
    values = read(config.runtimeEnvironment);
    identities = read(config.environment);
  } catch {
    throw new Error('RUNTIME_ENVIRONMENT_MAP_INVALID');
  }
  for (const map of [values, identities])
    requireValue(
      map !== null && typeof map === 'object' && !Array.isArray(map),
      'RUNTIME_ENVIRONMENT_MAP_INVALID',
    );
  const profiles = descriptor.profiles.filter((profile) => profile.profileId === 'rc');
  requireValue(profiles.length === 1 && profiles[0].mode === 'fixed', 'RC_PROFILE_INVALID');
  const tasks = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  requireValue(tasks.size === descriptor.tasks.length, 'RC_TASK_POPULATION_INVALID');
  const selected = new Set();
  const visiting = new Set();
  const keys = new Set();
  function visit(id) {
    requireValue(!visiting.has(id) && tasks.has(id), 'RC_TASK_DEPENDENCY_INVALID');
    if (selected.has(id)) return;
    visiting.add(id);
    const task = tasks.get(id);
    for (const dependency of task.dependencies) visit(dependency);
    for (const key of task.allowlistedEnv) keys.add(key);
    visiting.delete(id);
    selected.add(id);
  }
  for (const id of profiles[0].requiredNodes) visit(id);
  const environment = minimalEnvironment();
  for (const key of keys) {
    requireValue(
      typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key),
      'RUNTIME_ENVIRONMENT_KEY_INVALID',
    );
    const present = Object.hasOwn(values, key);
    const identity = Object.hasOwn(identities, key) ? identities[key] : undefined;
    requireValue(
      identity === null ||
        (typeof identity === 'string' && /^sha256:[a-f0-9]{64}$/u.test(identity)),
      'RUNTIME_ENVIRONMENT_IDENTITY_INVALID',
    );
    requireValue(
      identity === null
        ? !present
        : present &&
            typeof values[key] === 'string' &&
            identity === `sha256:${sha(Buffer.from(values[key], 'utf8'))}`,
      'RUNTIME_ENVIRONMENT_IDENTITY_MISMATCH',
    );
    if (present) environment[key] = values[key];
    else Reflect.deleteProperty(environment, key);
  }
  return environment;
}

function run() {
  const [phase, configPath, receiptPath] = process.argv.slice(2);
  requireValue(
    ['prerequisites', 'certify', 'evidence'].includes(phase) && configPath && receiptPath,
    'USAGE',
  );
  const config = read(configPath);
  const current = inspectPrerequisites(config, configPath);
  const { descriptor, ...report } = current;
  if (phase === 'prerequisites') {
    writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: report.checks })}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  assertFresh(read(receiptPath), report);
  let candidateReceipt = config.receipt;
  if (phase === 'certify') {
    const environment = certificationEnvironment(config, descriptor);
    const cli = resolve(config.packageRoot, 'dist/runtime/index/bin.js');
    const output = command(
      [
        process.execPath,
        cli,
        'check',
        '--rc',
        '--run',
        '--as-role',
        'inspector',
        '--write',
        '--format',
        'json',
        '--repo-root',
        config.repo,
      ],
      config.repo,
      environment,
    );
    const result = JSON.parse(output);
    const taskReport = result.result?.value ?? result;
    requireValue(taskReport.exitCode === 0 && taskReport.receipt?.path, 'RC_RECEIPT_MISSING');
    candidateReceipt = taskReport.receipt.path;
    assertFresh(report, inspectPrerequisites(config, configPath));
  }
  requireValue(candidateReceipt, 'CANDIDATE_RECEIPT_REQUIRED');
  const exporter = join(config.packageRoot, 'dist/runtime/evidence-verification/src/export-cli.js');
  const args = [
    process.execPath,
    exporter,
    '--repo',
    config.repo,
    '--receipt',
    candidateReceipt,
    '--results-dir',
    join(config.repo, '.devai/state/check-cache/v1/results'),
    '--profile',
    'rc',
    '--commit',
    report.bindings.commit,
    '--tree',
    report.bindings.tree,
    '--toolchain',
    config.toolchain,
    '--environment',
    config.environment,
    '--private-key',
    config.privateKey,
    '--public-key',
    config.publicKey,
    '--signer-id',
    config.signerId,
    '--output-dir',
    config.outputDir,
  ];
  command([...args, '--preflight', 'true'], dirname(configPath));
  command(args, dirname(configPath));
  process.stdout.write('{"ok":true,"phase":"evidence"}\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch {
    process.stderr.write('RELEASE_PREREQUISITE_OR_EVIDENCE_FAILED\n');
    process.exitCode = 1;
  }
}
