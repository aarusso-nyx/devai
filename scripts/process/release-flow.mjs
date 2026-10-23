#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateIdentity, externalDirectory, buildDocs } from './docs-build.mjs';
import {
  assertFresh,
  certificationEnvironment,
  certifyCandidate,
  exportCandidate,
  inspectPrerequisites,
} from './release-prerequisites.mjs';
import { inspectAssets } from './rehearsal.mjs';
import { runValidation } from './validation-runner.mjs';

const read = (path) => {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('RELEASE_FLOW_FILE_INVALID');
  return JSON.parse(readFileSync(path, 'utf8'));
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (a, b) => canonical(a) === canonical(b);
const command = (argv, cwd) =>
  execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function saveJournal(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function recoverJournal(path) {
  const lock = `${path}.lock`;
  if (!lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink())
    throw new Error('RELEASE_FLOW_LOCK_INVALID');
  const owner = Number(readFileSync(lock, 'utf8').trim());
  if (!Number.isSafeInteger(owner) || owner <= 1) throw new Error('RELEASE_FLOW_LOCK_INVALID');
  try {
    process.kill(owner, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    rmSync(lock);
    return;
  }
  throw new Error('RELEASE_FLOW_LOCK_LIVE');
}

/** A journal is a restart hint. Every completed phase must verify its output again. */
export function checkpoint(path, journal, name, execute, verify) {
  const prior = journal.phases[name];
  if (prior?.status === 'complete') {
    verify(prior.value, { replayed: true });
    return prior.value;
  }
  journal.phases[name] = { status: 'running' };
  saveJournal(path, journal);
  const value = execute();
  verify(value, { replayed: false });
  journal.phases[name] = { status: 'complete', value };
  saveJournal(path, journal);
  return value;
}

// Prerequisites check the final files. Match the exporter's no-follow parent
// rules too, before spending time on RC. Stable macOS system aliases are allowed
// by the installed verifier; user-created directory aliases are not.
export function assertControlPaths(config) {
  const check = (field, directory = false) => {
    if (typeof config[field] !== 'string') return;
    let cursor = resolve(directory ? config[field] : dirname(config[field]));
    if (
      process.platform === 'darwin' &&
      (cursor === '/var' ||
        cursor.startsWith('/var/') ||
        cursor === '/tmp' ||
        cursor.startsWith('/tmp/'))
    )
      cursor = `/private${cursor}`;
    while (cursor !== dirname(cursor)) {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error(`RELEASE_FLOW_CONTROL_SYMLINK:${field}`);
      cursor = dirname(cursor);
    }
  };
  for (const field of [
    'toolchain',
    'environment',
    'runtimeEnvironment',
    'privateKey',
    'publicKey',
    'trustStore',
    'releaseSigners',
  ])
    check(field);
  check('repo', true);
  check('packageRoot', true);
  check('outputDir');
}

export function releasePreflight(config, descriptor) {
  // Reuse the exact existing security and workflow checks. None substitutes for
  // the full RC or the independently repeated rehearsal security audit.
  assertControlPaths(config);
  certificationEnvironment(config, descriptor);
  command([process.execPath, join(config.repo, 'scripts/check-workflows.mjs')], config.repo);
  command(
    [process.execPath, join(config.repo, 'scripts/check-release-static-integrity.mjs')],
    config.repo,
  );
  buildDocs({ repo: config.repo, mode: 'preflight' });
}

export function verifyExport(config, report) {
  const output = config.outputDir;
  command(
    [
      process.execPath,
      join(config.packageRoot, 'dist/runtime/evidence-verification/src/cli.js'),
      '--envelope',
      join(output, 'envelope.json'),
      '--results-dir',
      join(output, 'results'),
      '--artifacts-dir',
      join(output, 'artifacts'),
      '--task-policy',
      join(output, 'task-policy.json'),
      '--trust',
      config.trustStore,
      '--repository',
      'aarusso-nyx/devai',
      '--commit',
      report.bindings.commit,
      '--tree',
      report.bindings.tree,
      '--policy-digest',
      config.policyDigest,
      '--binding',
      'exact-commit',
    ],
    config.repo,
  );
  return sha(readFileSync(join(output, 'envelope.json')));
}

function verifyRc(config, receipt, report, parent) {
  const temporary = mkdtempSync(join(parent, 'rc-preflight-'));
  try {
    command(
      [
        process.execPath,
        join(config.packageRoot, 'dist/runtime/evidence-verification/src/export-cli.js'),
        '--repo',
        config.repo,
        '--receipt',
        receipt,
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
        '--public-key',
        config.publicKey,
        '--signer-id',
        config.signerId,
        '--output-dir',
        join(temporary, 'export'),
        '--preflight',
        'true',
      ],
      parent,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function oneNpmResult(value) {
  if (Array.isArray(value) && value.length === 1) return value[0];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('name' in value || 'filename' in value) return value;
    const entries = Object.values(value);
    if (entries.length === 1 && entries[0] && typeof entries[0] === 'object') return entries[0];
  }
  throw new Error('RELEASE_FLOW_NPM_RESPONSE_AMBIGUOUS');
}

export function assertPromotedAssets(expectedFiles, directory) {
  if (!same(inspectAssets(directory).files, expectedFiles))
    throw new Error('RELEASE_FLOW_PUBLICATION_PROMOTION_MISMATCH');
}

function rehearsal(config, journal, expected, parent) {
  if (
    expected.commit !== journal.bindings.commit ||
    expected.tree !== journal.bindings.tree ||
    expected.ledger?.policy_digest !== config.policyDigest
  )
    throw new Error('RELEASE_FLOW_REHEARSAL_BINDING_MISMATCH');
  const ledger = {
    envelope_sha256: journal.phases.evidence.value.envelopeSha256,
    task_policy_sha256: sha(readFileSync(join(config.outputDir, 'task-policy.json'))),
    trust_store_sha256: journal.bindings.trust,
    toolchain_sha256: journal.bindings.toolchain,
    environment_sha256: journal.bindings.environment,
    verifier_provenance_sha256: journal.bindings.verifier,
    verifier_package: '@aarusso-nyx/devai',
    verifier_package_version: journal.bindings.packageVersion,
  };
  if (config.releaseSigners) ledger.release_signers_sha256 = journal.bindings.releaseSigners;
  if (Object.entries(ledger).some(([key, value]) => expected.ledger[key] !== value))
    throw new Error('RELEASE_FLOW_REHEARSAL_TRUST_MISMATCH');
  const temporary = mkdtempSync(join(parent, 'rehearsal-'));
  const assets = join(temporary, 'assets');
  const context = join(temporary, 'expected.json');
  try {
    writeFileSync(context, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
    command(
      [
        process.execPath,
        join(config.repo, 'scripts/process/rehearsal.mjs'),
        'promote',
        assets,
        context,
      ],
      config.repo,
    );
    const result = inspectAssets(assets);
    // The selected ledger is externally expected, and its evidence must also
    // equal this flow's verified export. No self-selected evidence is admitted.
    if (result.manifest.ledger.envelope_sha256 !== journal.phases.evidence.value.envelopeSha256)
      throw new Error('RELEASE_FLOW_REHEARSAL_EVIDENCE_MISMATCH');
    return { expected, files: result.files, manifest: result.manifest };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function publication(config, journal, parent, runId) {
  if (!/^[1-9][0-9]*$/u.test(String(runId)))
    throw new Error('RELEASE_FLOW_PUBLICATION_RUN_REQUIRED');
  const workflow = JSON.parse(
    command(['gh', 'api', `repos/aarusso-nyx/devai/actions/runs/${runId}`], config.repo),
  );
  if (
    workflow.status !== 'completed' ||
    workflow.conclusion !== 'success' ||
    workflow.event !== 'workflow_dispatch' ||
    workflow.path !== '.github/workflows/release.yml' ||
    workflow.head_sha !== journal.phases.rehearsal.value.expected.workflowCommit
  )
    throw new Error('RELEASE_FLOW_PUBLICATION_RUN_NOT_SUCCESSFUL');
  const jobs = JSON.parse(
    command(
      [
        'gh',
        'api',
        '--paginate',
        '--slurp',
        `repos/aarusso-nyx/devai/actions/runs/${runId}/attempts/${workflow.run_attempt}/jobs?per_page=100`,
      ],
      config.repo,
    ),
  ).flatMap((page) => page.jobs);
  for (const name of [
    'Verify protected RC ledger',
    'Create canonical Release and mirror exact package',
  ]) {
    if (
      !jobs.some(
        (job) => job.name === name && job.status === 'completed' && job.conclusion === 'success',
      )
    )
      throw new Error('RELEASE_FLOW_PUBLICATION_JOBS_NOT_SUCCESSFUL');
  }
  const { files, manifest } = journal.phases.rehearsal.value;
  const tag = manifest.release.tag;
  if (typeof config.releaseSigners !== 'string')
    throw new Error('RELEASE_FLOW_RELEASE_SIGNERS_REQUIRED');
  const git = (...args) => command(['git', ...args], config.repo).trim();
  if (
    git('cat-file', '-t', tag) !== 'tag' ||
    git('rev-parse', `${tag}^{commit}`) !== journal.bindings.commit
  )
    throw new Error('RELEASE_FLOW_TAG_MISMATCH');
  command(
    [
      'git',
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${config.releaseSigners}`,
      'verify-tag',
      tag,
    ],
    config.repo,
  );
  const release = JSON.parse(
    command(['gh', 'api', `repos/aarusso-nyx/devai/releases/tags/${tag}`], config.repo),
  );
  if (
    release.draft !== false ||
    release.immutable !== true ||
    release.prerelease !== manifest.release.prerelease ||
    release.tag_name !== tag ||
    !same(release.assets.map((asset) => asset.name).sort(), Object.keys(files).sort())
  )
    throw new Error('RELEASE_FLOW_PUBLICATION_INCOMPLETE');
  const temporary = mkdtempSync(join(parent, 'publication-'));
  try {
    // Bind successful publication jobs to this release, not merely another tag
    // published by the same workflow commit. These are the exact assets handed
    // from protected verification to the publisher in the selected attempt.
    const promoted = join(temporary, 'promoted');
    command(
      [
        'gh',
        'run',
        'download',
        String(runId),
        '--repo',
        'aarusso-nyx/devai',
        '--name',
        `devai-release-assets-${workflow.run_attempt}`,
        '--dir',
        promoted,
      ],
      config.repo,
    );
    assertPromotedAssets(files, promoted);
    command(
      ['gh', 'release', 'download', tag, '--repo', 'aarusso-nyx/devai', '--dir', temporary],
      config.repo,
    );
    for (const [name, digest] of Object.entries(files))
      if (sha(readFileSync(join(temporary, name))) !== digest)
        throw new Error('RELEASE_FLOW_ASSET_MISMATCH');
    const spec = `${manifest.release.package}@${manifest.release.version}`;
    const registry = '--registry=https://npm.pkg.github.com';
    const metadata = oneNpmResult(
      JSON.parse(command(['npm', 'view', spec, registry, '--json'], temporary)),
    );
    if (metadata.name !== manifest.release.package || metadata.version !== manifest.release.version)
      throw new Error('RELEASE_FLOW_REGISTRY_IDENTITY_MISMATCH');
    const tags = JSON.parse(
      command(
        ['npm', 'view', manifest.release.package, 'dist-tags', registry, '--json'],
        temporary,
      ),
    );
    if (tags[manifest.release.dist_tag] !== manifest.release.version)
      throw new Error('RELEASE_FLOW_REGISTRY_TAG_MISMATCH');
    const packed = oneNpmResult(
      JSON.parse(command(['npm', 'pack', spec, registry, '--json', '--ignore-scripts'], temporary)),
    );
    if (
      typeof packed.filename !== 'string' ||
      packed.filename !== packed.filename.split(/[\\/]/u).at(-1) ||
      sha(readFileSync(join(temporary, packed.filename))) !== manifest.artifacts.package.sha256
    )
      throw new Error('RELEASE_FLOW_REGISTRY_BYTES_MISMATCH');
    return {
      runId: String(runId),
      attempt: workflow.run_attempt,
      releaseId: release.id,
      tag,
      packageSha256: manifest.artifacts.package.sha256,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function resumeRelease(
  configPath,
  journalPath,
  mode = 'prepare',
  expectedPath,
  publicationRunId,
) {
  if (!['preflight', 'prepare', 'rehearsal', 'publication'].includes(mode))
    throw new Error('RELEASE_FLOW_USAGE');
  const config = read(configPath);
  const parent = externalDirectory(config.repo, dirname(resolve(journalPath)));
  externalDirectory(config.repo, dirname(resolve(configPath)));
  // Fail closed on abandoned ownership. Recovery is an explicit human operation.
  const lock = `${journalPath}.lock`;
  writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  try {
    const current = inspectPrerequisites(config, configPath, {
      allowExistingOutput: existsSync(config.outputDir),
    });
    if (!current.ok)
      throw new Error(`RELEASE_FLOW_PREREQUISITES_FAILED:${JSON.stringify(current.checks)}`);
    const { descriptor, ...report } = current;
    const controls = [
      'release-flow.mjs',
      'release-prerequisites.mjs',
      'docs-build.mjs',
      'validation-runner.mjs',
      'rehearsal.mjs',
    ];
    const bindings = {
      ...report.bindings,
      controls: controls.map((name) =>
        sha(readFileSync(join(config.repo, 'scripts/process', name))),
      ),
    };
    if (config.releaseSigners) {
      externalDirectory(config.repo, config.releaseSigners);
      readFileSync(config.releaseSigners);
      if (
        !lstatSync(config.releaseSigners).isFile() ||
        lstatSync(config.releaseSigners).isSymbolicLink()
      )
        throw new Error('RELEASE_FLOW_SIGNERS_INVALID');
      bindings.releaseSigners = sha(readFileSync(config.releaseSigners));
    }
    let journal;
    if (existsSync(journalPath)) {
      journal = read(journalPath);
      if (journal.schemaVersion !== '1.0.0' || !same(journal.bindings, bindings))
        throw new Error('RELEASE_FLOW_INPUTS_CHANGED');
    } else {
      if (existsSync(config.outputDir)) throw new Error('RELEASE_FLOW_UNOWNED_EXPORT');
      journal = { schemaVersion: '1.0.0', bindings, phases: {} };
      saveJournal(journalPath, journal);
    }
    // Re-run live advisories, current trust and environment checks on every resume.
    releasePreflight(config, descriptor);
    if (mode === 'preflight') return { ok: true, phase: 'preflight', journal: journalPath };
    const fresh = () => {
      assertControlPaths(config);
      return assertFresh(
        report,
        inspectPrerequisites(config, configPath, {
          allowExistingOutput: existsSync(config.outputDir),
        }),
      );
    };
    // A crash after export but before checkpoint is reconciled by the verifier.
    // An incomplete or foreign export refuses; it is never deleted or repaired.
    if (existsSync(config.outputDir)) {
      const envelopeSha256 = verifyExport(config, report);
      const prior = journal.phases.evidence;
      if (!prior || (prior.status === 'complete' && prior.value.envelopeSha256 !== envelopeSha256))
        throw new Error('RELEASE_FLOW_EXPORT_MISMATCH');
      journal.phases.evidence = { status: 'complete', value: { envelopeSha256 } };
      saveJournal(journalPath, journal);
    } else {
      if (journal.phases.evidence?.status === 'complete')
        throw new Error('RELEASE_FLOW_EXPORT_MISSING');
      const receipt = checkpoint(
        journalPath,
        journal,
        'rc',
        () => certifyCandidate(config, descriptor),
        (value) => {
          fresh();
          verifyRc(config, value, report, parent);
        },
      );
      checkpoint(
        journalPath,
        journal,
        'evidence',
        () => {
          fresh();
          exportCandidate(config, report, receipt, configPath);
          return { envelopeSha256: verifyExport(config, report) };
        },
        (value) => {
          fresh();
          if (verifyExport(config, report) !== value.envelopeSha256)
            throw new Error('RELEASE_FLOW_EXPORT_MISMATCH');
        },
      );
    }
    if (mode !== 'prepare') {
      const expected = expectedPath ? read(expectedPath) : journal.phases.rehearsal?.value.expected;
      if (!expected) throw new Error('RELEASE_FLOW_REHEARSAL_SELECTION_REQUIRED');
      if (
        journal.phases.rehearsal?.status === 'complete' &&
        !same(journal.phases.rehearsal.value.expected, expected)
      )
        throw new Error('RELEASE_FLOW_REHEARSAL_SELECTION_CHANGED');
      checkpoint(
        journalPath,
        journal,
        'rehearsal',
        () => rehearsal(config, journal, expected, parent),
        (value, { replayed }) => {
          if (replayed && !same(rehearsal(config, journal, expected, parent), value))
            throw new Error('RELEASE_FLOW_REHEARSAL_CHANGED');
        },
      );
    }
    if (
      mode === 'publication' &&
      publicationRunId &&
      journal.phases.publication?.status === 'complete' &&
      String(publicationRunId) !== journal.phases.publication.value.runId
    )
      throw new Error('RELEASE_FLOW_PUBLICATION_SELECTION_CHANGED');
    if (mode === 'publication')
      checkpoint(
        journalPath,
        journal,
        'publication',
        () => publication(config, journal, parent, publicationRunId),
        (value, { replayed }) => {
          if (
            replayed &&
            !same(publication(config, journal, parent, publicationRunId ?? value.runId), value)
          )
            throw new Error('RELEASE_FLOW_PUBLICATION_CHANGED');
        },
      );
    fresh();
    candidateIdentity(config.repo);
    return {
      ok: true,
      phase: mode === 'prepare' ? 'evidence' : mode,
      publicationAuthorized: false,
      journal: journalPath,
    };
  } finally {
    rmSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--worker') {
      process.exitCode = await runValidation(
        [process.execPath, process.argv[1], '--worker', ...args],
        { exclusive: true },
      );
    } else {
      const [, mode, config, journal, expected, runId] = args;
      if (mode === 'recover') {
        recoverJournal(config);
      } else
        process.stdout.write(
          `${JSON.stringify(resumeRelease(config, journal, mode, expected, runId))}\n`,
        );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
