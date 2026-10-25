/** Real disposable DETRAN source rehearsal. No private DEVAI runtime imports.
 * node .../reconciliation-detran-driver.mjs prepare historical|refreshed EVIDENCE
 * All mutations are confined to a newly allocated external fixture. Source Git
 * is read only; archived ls-files output is rebuilt through update-index.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED = '/Volumes/Development/.codex/artifacts/detran';
const HANDOFF = join(SHARED, 'u1b1-shared-fixture-handoff-20261024');
const HISTORICAL = join(SHARED, 'pr211-main-reconciliation-20261023');
export const CHAIN = 'record/proofs/chain.json';
export const EPOCH = 'record/proofs/work/generic/R-0025.jsonl';
export const S2 = '9b2a190aa1276f4b15469b7079ed0d7c4c8c4c99';
export const MAIN335 = '7dfab8bdf61ffe935bca45578e0e65c09883f633';
export const MAIN449 = '7abe89cd3e7049fdcf38b33411d38a3442a0e1e1';
const INPUT_SHA = '5f5f5e9962eaba13fb6e194a84dc2a01c74ec52aa75d9f6b441bcbec53bf0b2a';
const EXPORT_SHA = 'd4d040e27816cc9ab86e677038ed66678ecf72ebec98a2083a342a83e35eab1f';
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function admitted(path, expected, size) {
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), expected, `Custody digest: ${path}`);
  if (size !== undefined) assert.equal(bytes.length, size, `Custody size: ${path}`);
  return bytes;
}
export function custody() {
  const inputPath = join(HANDOFF, 'fixture-input-manifest.json');
  const exporterPath = join(HANDOFF, 'exporter-acceptance-contract.json');
  const input = JSON.parse(admitted(inputPath, INPUT_SHA));
  const exporters = JSON.parse(admitted(exporterPath, EXPORT_SHA));
  for (const file of input.files) admitted(file.path, file.sha256, file.bytes);
  const historical = json(join(HISTORICAL, 'custody-manifest.json'));
  for (const path of [
    'proof-custody.json',
    'resolved-source.patch',
    'resolved-files.zip',
    'resolved-files-manifest.json',
  ])
    admitted(join(HISTORICAL, path), historical[path]);
  return { input, exporters, input_sha256: INPUT_SHA, exporter_sha256: EXPORT_SHA };
}
function command(bin, args, cwd, env, input) {
  const result = spawnSync(bin, args, { cwd, env, input, maxBuffer: 96 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function git(root, args, env, input, allowed = [0]) {
  const result = command(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', ...args],
    root,
    env,
    input,
  );
  assert.ok(allowed.includes(result.status), `Fixture git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
function records(bytes) {
  const value = JSON.parse(bytes);
  assert.ok(Array.isArray(value.records));
  return value;
}
/** Independent physical-row oracle: selected-chain exact direct anchors only.
 * This derives expected orphan positions; actual CLI must independently verify
 * custody/ancestry/epochs and expose its supported recovery classification.
 */
export function orphanOracle(chainBytes, epochBytes) {
  const selected = records(chainBytes);
  const rows = epochBytes.toString('utf8').split('\n');
  assert.equal(rows.pop(), '', 'Original epoch must retain final LF');
  const anchors = selected.records.filter((record) => record.proof_path === EPOCH);
  return rows.flatMap((row, index) => {
    const rowSha = sha(Buffer.from(row));
    const sequence = index + 1;
    return anchors.some(
      (record) => record.proof_sequence === sequence && record.proof_sha256 === rowSha,
    )
      ? []
      : [
          {
            proof_path: EPOCH,
            proof_sequence: sequence,
            proof_sha256: rowSha,
            raw_line_with_lf_sha256: sha(Buffer.from(row + '\n')),
          },
        ];
  });
}
function safeRelative(path) {
  assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.includes('\\'));
  assert.ok(path.split('/').every((part) => part && part !== '.' && part !== '..'));
  assert.notEqual(path, CHAIN);
  assert.notEqual(path, 'law/security/authorization.json');
}
function restoreHistoricalResolution(root, input, env) {
  // ZIP is an exact historical source resolution, never applied to refreshed main.
  const manifest = json(join(HISTORICAL, 'resolved-files-manifest.json'));
  assert.equal(manifest.s2, S2);
  assert.equal(manifest.main, MAIN335);
  assert.equal(input.resolvedZipMembers.length, 58);
  for (const member of input.resolvedZipMembers) {
    safeRelative(member.member);
    const extraction = command(
      '/usr/bin/unzip',
      ['-p', join(HISTORICAL, 'resolved-files.zip'), member.member],
      root,
      env,
    );
    assert.equal(extraction.status, 0);
    assert.equal(extraction.stdout.length, member.bytes);
    assert.equal(sha(extraction.stdout), member.sha256);
    assert.equal(manifest.resolved_file_sha256[member.member], member.sha256);
    const path = join(root, member.member);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, extraction.stdout);
  }
  // Reconstruct the actual DIRC using Git, never install the semantic dump as index.
  const stages = input.files.find((file) =>
    file.path.endsWith('/preserved-index-stage-entries.bin'),
  );
  const bytes = admitted(stages.path, stages.sha256, stages.bytes);
  git(root, ['read-tree', '--empty'], env);
  git(root, ['update-index', '-z', '--index-info'], env, bytes);
  assert.deepEqual(git(root, ['ls-files', '--stage', '-z'], env), bytes);
  // Align every stage-zero source with its exact admitted blob, keeping both
  // unresolved machine outputs and the active proof conflict untouched.
  git(root, ['checkout-index', '--all', '--force'], env);
  for (const member of input.resolvedZipMembers)
    assert.equal(sha(readFileSync(join(root, member.member))), member.sha256);
}
export function prepareFixture(mode, evidencePath) {
  assert.ok(mode === 'historical' || mode === 'refreshed');
  const held = custody();
  const source = realpathSync(
    process.env.DEVAI_DETRAN_SOURCE ?? '/Volumes/Development/projects/stech/detran',
  );
  const base = realpathSync(mkdtempSync(join(tmpdir(), `devai-detran-${mode}-`)));
  const root = join(base, 'repository');
  const evidence = resolve(evidencePath);
  assert.ok(relative(base, evidence).startsWith('..'), 'Evidence must be outside candidate source');
  mkdirSync(evidence, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    NO_COLOR: '1',
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') &&
      ![
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT',
      ].includes(key)
    )
      Reflect.deleteProperty(env, key);
  }
  // No --shared, alternates or hardlinks: all subsequent Git mutations are local.
  const cloned = command(
    '/usr/bin/git',
    ['clone', '--local', '--no-hardlinks', '--no-checkout', source, root],
    base,
    env,
  );
  assert.equal(cloned.status, 0, cloned.stderr.toString());
  git(root, ['remote', 'remove', 'origin'], env);
  for (const sourceFile of held.input.gitSources) {
    const bytes = git(root, ['show', `${sourceFile.ref}:${sourceFile.path}`], env);
    assert.equal(sha(bytes), sourceFile.sha256);
    assert.equal(bytes.length, sourceFile.bytes);
    if (sourceFile.records !== undefined) {
      const chain = records(bytes);
      assert.equal(chain.records.length, sourceFile.records);
      assert.equal(chain.head, sourceFile.head);
    }
  }
  const selected = mode === 'historical' ? MAIN335 : MAIN449;
  git(root, ['update-ref', 'refs/heads/main', selected], env);
  git(root, ['checkout', '--detach', S2], env);
  const merged = command(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Inspector fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'merge',
      '--no-commit',
      '--no-ff',
      selected,
    ],
    root,
    env,
  );
  assert.equal(merged.status, 1, 'Expected actual unresolved source merge');
  if (mode === 'historical') restoreHistoricalResolution(root, held.input, env);
  const semantic = git(root, ['ls-files', '--stage', '-z'], env);
  const unresolved = [
    ...new Set(
      git(root, ['diff', '--name-only', '--diff-filter=U', '-z'], env)
        .toString()
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  if (mode === 'historical')
    assert.deepEqual(unresolved, ['law/security/authorization.json', CHAIN]);
  const selectedBytes = git(root, ['show', `${selected}:${CHAIN}`], env);
  const epoch = git(root, ['show', `${S2}:${EPOCH}`], env);
  const oldConstitution = readFileSync(join(root, '.devai/pin/constitution.md'));
  const oldPolicy = readFileSync(join(root, '.devai/config/authority-policy.json'));
  // Custody lives outside the mutable candidate and is not interpreted as approval.
  writeFileSync(join(evidence, 'original-pin.md'), oldConstitution);
  writeFileSync(join(evidence, 'original-authority-policy.json'), oldPolicy);
  writeFileSync(join(evidence, 'index-before.bin'), semantic);
  const result = {
    standing:
      mode === 'historical'
        ? 'EXACT_HISTORICAL_335_SOURCE_FIXTURE_NOT_RUNTIME_SUCCESS'
        : 'ACTUAL_REFRESHED_449_MERGE_NO_RESTAMPED_RESOLUTION',
    root,
    base,
    mode,
    selected_parent: selected,
    head: S2,
    merge_head: git(root, ['rev-parse', 'MERGE_HEAD'], env).toString().trim(),
    selected_records: records(selectedBytes).records.length,
    selected_head: records(selectedBytes).head,
    selected_sha256: sha(selectedBytes),
    epoch_sha256: sha(epoch),
    semantic_index_sha256: sha(semantic),
    unresolved,
    expected_orphans: orphanOracle(selectedBytes, epoch),
    old_pin_sha256: sha(oldConstitution),
    old_policy_sha256: sha(oldPolicy),
    source_artifacts_sha256: held.input_sha256,
    exporter_contract_sha256: held.exporter_sha256,
    upgraded: false,
    native_ready: false,
    detran_live_effects: false,
  };
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
export function publicPlan(fixture, packageRoot, evidencePath) {
  const packagePath = realpathSync(packageRoot);
  const manifest = json(join(packagePath, 'package.json'));
  assert.equal(manifest.name, '@aarusso-nyx/devai');
  assert.equal(manifest.version, '2.8.0');
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.devai;
  const bin = resolve(packagePath, declared);
  assert.ok(bin.startsWith(packagePath + '/') && existsSync(bin));
  const argv = [
    'evidence',
    'reconcile',
    'plan',
    '--repo-root',
    fixture.root,
    '--selected-parent',
    fixture.selected_parent,
    '--published-ref',
    'refs/heads/main',
    '--as-role',
    'architect',
    '--format',
    'json',
  ];
  const before = command(
    '/usr/bin/git',
    ['ls-files', '--stage', '-z'],
    fixture.root,
    process.env,
  ).stdout;
  const result = command(process.execPath, [bin, ...argv], fixture.root, {
    ...process.env,
    NO_COLOR: '1',
    GIT_OPTIONAL_LOCKS: '0',
  });
  writeFileSync(join(evidencePath, 'plan.stdout'), result.stdout);
  writeFileSync(join(evidencePath, 'plan.stderr'), result.stderr);
  assert.deepEqual(
    command('/usr/bin/git', ['ls-files', '--stage', '-z'], fixture.root, process.env).stdout,
    before,
  );
  return {
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    argv,
    package_json_sha256: sha(readFileSync(join(packagePath, 'package.json'))),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, mode, evidence] = process.argv.slice(2);
  assert.equal(operation, 'prepare');
  assert.ok(evidence, 'Explicit external evidence directory required');
  process.stdout.write(JSON.stringify(prepareFixture(mode, evidence), null, 2) + '\n');
}
