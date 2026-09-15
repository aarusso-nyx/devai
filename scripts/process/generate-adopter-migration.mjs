#!/usr/bin/env node
// Local preparation only: the installed package renders into a disposable target.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hash = (data, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(data).digest(encoding);
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
function execute(argv, cwd, env = process.env) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  requireValue(result.status === 0, 'MIGRATION_COMMAND_FAILED');
  return result.stdout;
}
function authenticate(name, version, tarball) {
  const metadata = JSON.parse(
    execute([
      'npm',
      'view',
      `${name}@${version}`,
      '--json',
      '--registry',
      'https://npm.pkg.github.com',
    ]),
  );
  requireValue(
    metadata.name === name && metadata.version === version,
    'MIGRATION_PACKAGE_IDENTITY',
  );
  const bytes = readFileSync(tarball);
  requireValue(
    metadata.dist.shasum === hash(bytes, 'sha1') &&
      metadata.dist.integrity === `sha512-${hash(bytes, 'sha512', 'base64')}`,
    'MIGRATION_TARBALL_MISMATCH',
  );
  return {
    name,
    version,
    tarball: metadata.dist.tarball,
    shasum: metadata.dist.shasum,
    integrity: metadata.dist.integrity,
    sha256: hash(bytes),
  };
}
function main() {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  requireValue(!existsSync(config.outputDir), 'MIGRATION_OUTPUT_EXISTS');
  const manifest = JSON.parse(readFileSync(join(config.packageRoot, 'package.json'), 'utf8'));
  requireValue(manifest.name === '@aarusso-nyx/devai', 'MIGRATION_PACKAGE_NAME');
  const target = authenticate(manifest.name, manifest.version, config.packageTarball);
  // Compare all authenticated tarball members to the installed package before
  // executing its renderer. Extraction, package hooks and source imports are absent.
  execute([
    'python3',
    '-B',
    '-c',
    `
import pathlib, sys
sys.path.insert(0, sys.argv[1])
from evidence_transport import read_archive, directory_files
files = read_archive(pathlib.Path(sys.argv[2]).read_bytes())
root = pathlib.Path(sys.argv[3])
expected_dist = {name[len('package/dist/'):]: data for name, data in files.items() if name.startswith('package/dist/')}
if directory_files(root / 'dist') != expected_dist: raise ValueError('installed population drift')
for name, data in files.items():
    if not name.startswith('package/'): raise ValueError('package root')
    path = root / name[len('package/'):]
    if path.is_symlink() or not path.is_file() or path.read_bytes() != data: raise ValueError('installed drift')
`,
    dirname(fileURLToPath(import.meta.url)),
    config.packageTarball,
    config.packageRoot,
  ]);
  const policy = JSON.parse(
    readFileSync(
      join(config.packageRoot, 'dist/law/policy/trusted-local-rc-verifier-package.json'),
      'utf8',
    ),
  );
  const provider = authenticate(
    policy.package.name,
    policy.package.version,
    config.providerTarball,
  );
  requireValue(
    provider.shasum === policy.package.shasum_sha1 &&
      provider.integrity === policy.package.integrity_sri &&
      provider.tarball === policy.package.tarball,
    'MIGRATION_PROVIDER_POLICY_MISMATCH',
  );
  // The Inspector still compares provenance against this authenticated provider.
  const provenance = execute([
    'python3',
    '-B',
    '-c',
    `
import pathlib, sys
sys.path.insert(0, sys.argv[1])
from evidence_transport import read_archive
print(read_archive(pathlib.Path(sys.argv[2]).read_bytes())['package/dist/runtime/evidence-verification/provenance.json'].decode(), end='')
`,
    dirname(fileURLToPath(import.meta.url)),
    config.providerTarball,
  ]);
  requireValue(
    hash(provenance) === policy.verifier.provenance_sha256,
    'MIGRATION_PROVENANCE_MISMATCH',
  );
  const temporary = mkdtempSync(join(tmpdir(), 'devai-migration-'));
  try {
    execute(['git', 'init', '--quiet', temporary], temporary);
    mkdirSync(join(temporary, '.devai'), { recursive: true });
    const assertConfigTree = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        requireValue(
          !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()),
          'MIGRATION_CONFIG_LINK_OR_SPECIAL_FILE',
        );
        if (entry.isDirectory()) assertConfigTree(join(directory, entry.name));
      }
    };
    assertConfigTree(join(config.adopterRoot, '.devai/config'));
    cpSync(join(config.adopterRoot, '.devai/config'), join(temporary, '.devai/config'), {
      recursive: true,
      dereference: false,
    });
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
    execute(
      [
        process.execPath,
        join(config.packageRoot, 'dist/runtime/index/bin.js'),
        'init',
        'apply',
        'harness',
        '--target',
        temporary,
        '--include',
        'ci',
        '--force',
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ],
      temporary,
      env,
    );
    const workflowDirectory = join(temporary, '.github/workflows');
    const workflows = readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'));
    requireValue(workflows.length === 1, 'MIGRATION_WORKFLOW_AMBIGUOUS');
    const workflow = workflows[0];
    const next = readFileSync(join(workflowDirectory, workflow));
    const oldPath = join(config.adopterRoot, '.github/workflows', workflow);
    const old = existsSync(oldPath) ? readFileSync(oldPath) : Buffer.alloc(0);
    mkdirSync(config.outputDir, { recursive: false });
    writeFileSync(join(config.outputDir, 'workflow-before.yml'), old);
    writeFileSync(join(config.outputDir, 'workflow-after.yml'), next);
    const bundle = {
      schemaVersion: '1.0.0',
      target,
      provider,
      verifier: policy.verifier,
      releaseSource: policy.package.release_source,
      workflow: `.github/workflows/${workflow}`,
      beforeSha256: hash(old),
      afterSha256: hash(next),
      protectedChanges: { [policy.external_duplicate.name]: policy.verifier.provenance_sha256 },
      authorization:
        'Inspector verifies; Owner separately approves protected changes. No effects applied.',
    };
    writeFileSync(join(config.outputDir, 'migration.json'), `${JSON.stringify(bundle, null, 2)}\n`);
    writeFileSync(
      join(config.outputDir, 'REVIEW.md'),
      `# Adopter migration to ${target.version}\n\n1. Inspector verifies the authenticated target/provider tarballs, verifier file population and binary mappings against migration.json and the signed provider release.\n2. Review workflow-before.yml and workflow-after.yml; require the current adopter workflow to match beforeSha256 before applying.\n3. Owner separately authorizes the exact protected variable change.\n4. Pin the target package and regenerate the reviewed workflow through init apply harness. Preserve unrelated configuration.\n5. Run the installed non-writing export preflight and issue a fresh exact-candidate receipt.\n\nThis directory is a review bundle, not authorization or a migration executor.\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, targetVersion: target.version, providerVersion: provider.version, workflow: basename(workflow) })}\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
try {
  main();
} catch {
  process.stderr.write('MIGRATION_PREPARATION_FAILED\n');
  process.exitCode = 1;
}
