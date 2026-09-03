import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  chmodSync,
  closeReadOnlySync,
  closeSync,
  existsSync,
  fileOpenConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openReadOnlyNoFollowSync,
  openSync,
  readFileSync,
  readExactGitTreeSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  bindReleaseToolProcessOptions,
  parseTaskDescriptor,
  runCheckTasks,
  type CheckRunnerReport,
  type TaskDescriptor,
} from './check-runner/index.js';
import { resolveTaskExecutable, type ResolvedTaskExecutable } from './check-runner/executable.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';

type Json = Readonly<Record<string, unknown>>;

export interface BuiltInReleaseLifecycleLocalContext {
  readonly repo_root: string;
  readonly resolve_receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly resolve_plan_input: (input: Json) => unknown;
  readonly read_contained_bytes: (path: string) => Buffer;
  readonly run_checks?: typeof runCheckTasks;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown, code = 'release-local-adapter-input-invalid'): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Json;
}

function localErrorCode(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : '';
  const gitCodes: Readonly<Record<string, string>> = {
    GIT_TREE_IDENTITY_INVALID: 'release-candidate-identity-invalid',
    GIT_COMMIT_IDENTITY_MISMATCH: 'release-candidate-identity-mismatch',
    GIT_TREE_IDENTITY_MISMATCH: 'release-candidate-tree-mismatch',
    GIT_TREE_ENTRY_UNSUPPORTED: 'release-candidate-snapshot-unsupported-entry',
    GIT_TREE_PROJECTION_EMPTY: 'release-candidate-snapshot-empty',
    GIT_OBJECT_PATH_INVALID: 'release-candidate-snapshot-path-invalid',
    GIT_TREE_READ_FAILED: 'release-candidate-snapshot-read-failed',
  };
  return gitCodes[code] ?? (/^[a-z][a-z0-9-]+$/u.test(code) ? code : fallback);
}

function planReceipts(
  request: ReleaseLifecycleRequest,
  resolveReceipt: BuiltInReleaseLifecycleLocalContext['resolve_receipt'],
): readonly Json[] {
  const values = (request.receipt_locators ?? [])
    .filter((locator) => locator.kind === 'release-plan-receipt')
    .map((locator) => object(resolveReceipt(locator)));
  if (values.length !== request.candidate_locator.release_units.length) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return values;
}

function receiptInput(receipt: Json, kind: string): Json {
  const values = receipt['inputs'];
  if (!Array.isArray(values)) throw new Error('rpl-input-unresolved');
  const matches = values.map((value) => object(value)).filter((value) => value['kind'] === kind);
  if (matches.length !== 1) throw new Error('rpl-input-unresolved');
  return matches[0] as Json;
}

function artifact(
  path: string,
  bytes: Buffer,
): {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
} {
  return { path, sha256: sha256(bytes), size_bytes: bytes.byteLength };
}

function manifestEvidence(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
) {
  return request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => {
      const bytes = context.read_contained_bytes(pkg.manifest_path);
      const manifest = object(JSON.parse(bytes.toString('utf8')) as unknown);
      if (
        sha256(bytes) !== pkg.manifest_digest_sha256 ||
        manifest['name'] !== pkg.package_id ||
        manifest['version'] !== unit.version
      ) {
        throw new Error('release-package-manifest-identity-mismatch');
      }
      return {
        package_id: pkg.package_id,
        manifest: artifact(pkg.manifest_path, bytes),
        tarball: null,
        sbom: null,
        evidence_manifest: null,
        provider_result: null,
        trust: null,
      };
    }),
  }));
}

function materialInputs(
  receipts: readonly Json[],
  reports: readonly CheckRunnerReport[] = [],
): ReleaseStateMaterial['inputs'] {
  const values = new Map<string, ReleaseStateMaterial['inputs'][number]>();
  const stateKind = (kind: string): string =>
    kind === 'release-verification-profile'
      ? 'release-profile'
      : kind === 'action-registry-policy'
        ? 'action-registry'
        : kind;
  for (const receipt of receipts) {
    const inputs = receipt['inputs'];
    if (!Array.isArray(inputs)) throw new Error('rpl-input-unresolved');
    for (const raw of inputs) {
      const input = object(raw);
      if (
        typeof input['kind'] !== 'string' ||
        typeof input['path'] !== 'string' ||
        typeof input['sha256'] !== 'string'
      ) {
        throw new Error('rpl-input-unresolved');
      }
      const value = {
        kind: stateKind(input['kind']),
        path: input['path'],
        sha256: input['sha256'],
      };
      values.set(`${value.kind}\0${value.path}`, value);
    }
  }
  for (const report of reports) {
    const stage = report.receipt === undefined ? 'preflight' : 'certify';
    values.set(`task-policy\0task-policy/${stage}/test-tasks.json`, {
      kind: 'task-policy',
      path: `task-policy/${stage}/test-tasks.json`,
      sha256: report.plan.descriptorDigest,
    });
    values.set(`task-policy\0task-policy/${stage}/selection`, {
      kind: 'task-policy',
      path: `task-policy/${stage}/selection`,
      sha256: report.plan.taskPolicyDigest,
    });
    if (report.plan.toolchainDigest !== undefined) {
      values.set(`toolchain\0toolchain/check-runner/${stage}`, {
        kind: 'toolchain',
        path: `toolchain/check-runner/${stage}`,
        sha256: report.plan.toolchainDigest,
      });
    }
  }
  return [...values.values()].sort((left, right) =>
    `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`, 'en'),
  );
}

function exactCandidateDescriptor(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
): TaskDescriptor {
  const entries = readExactGitTreeSync(
    context.repo_root,
    request.candidate_locator.commit,
    request.candidate_locator.tree,
    'test-tasks.json',
  );
  if (
    entries.length !== 1 ||
    entries[0]?.path !== 'test-tasks.json' ||
    entries[0].mode === '120000'
  ) {
    throw new Error('release-task-policy-identity-mismatch');
  }
  try {
    return parseTaskDescriptor(JSON.parse(entries[0].bytes.toString('utf8')) as unknown);
  } catch {
    throw new Error('release-task-policy-identity-mismatch');
  }
}

function checkPassed(report: CheckRunnerReport, stage: 'preflight' | 'certify'): boolean {
  if (report.exitCode !== 0 || report.execution === undefined) return false;
  if (report.execution.some((entry) => entry.outcome !== 'PASS')) return false;
  return stage === 'preflight'
    ? report.preflightReceipt !== undefined
    : report.receipt !== undefined;
}

function runStage(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
  receipt: Json,
  stage: 'preflight' | 'certify',
): readonly CheckRunnerReport[] {
  const intentInput = receiptInput(receipt, 'release-intent');
  const profileInput = receiptInput(receipt, 'release-verification-profile');
  const intent = intentInput['inline_document'] ?? context.resolve_plan_input(intentInput);
  const intentDocument = object(intent);
  const base = object(intentDocument['base']);
  if (typeof base['commit'] !== 'string') throw new Error('rpl-input-unresolved');
  const profile = context.resolve_plan_input(profileInput);
  const descriptorDocument = exactCandidateDescriptor(context, request);
  const immutableDescriptor = (): TaskDescriptor =>
    parseTaskDescriptor(JSON.parse(canonicalJson(descriptorDocument)) as unknown);
  const run = context.run_checks ?? runCheckTasks;
  const preflight = run({
    repoRoot: context.repo_root,
    target: 'release',
    operation: 'run',
    releaseIntent: intent,
    releaseProfile: profile,
    baseCommit: base['commit'],
    releaseStage: 'preflight',
    descriptorDocument: immutableDescriptor(),
  });
  if (!checkPassed(preflight, 'preflight') || stage === 'preflight') return [preflight];
  return [
    preflight,
    run({
      repoRoot: context.repo_root,
      target: 'release',
      operation: 'run',
      releaseIntent: intent,
      releaseProfile: profile,
      baseCommit: base['commit'],
      releaseStage: 'certify',
      preflightReceipt: preflight.preflightReceipt?.value,
      descriptorDocument: immutableDescriptor(),
    }),
  ];
}

function checkProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: 'release preflight' | 'release certify',
): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const stage = action === 'release preflight' ? 'preflight' : 'certify';
      const reports = receipts.flatMap((receipt) => runStage(context, request, receipt, stage));
      if (
        reports.some(
          (report) => !checkPassed(report, report.preflightReceipt ? 'preflight' : 'certify'),
        )
      ) {
        return { outcome: 'failure', code: `release-${stage}-failed` };
      }
      const receiptDigests = [
        ...receipts.map((receipt) => String(receipt['receipt_digest_sha256'])),
        ...reports.flatMap((report) =>
          [report.preflightReceipt?.digest, report.receipt?.digest].filter(
            (value): value is string => value !== undefined,
          ),
        ),
      ].sort();
      return {
        outcome: 'success',
        material: {
          release_units: manifestEvidence(context, request),
          inputs: materialInputs(receipts, reports),
          evidence: {
            manifest_digest_sha256: canonicalSha256(reports),
            receipt_digests: [...new Set(receiptDigests)],
            independently_checkable: true,
          },
          artifacts: [],
        },
      };
    } catch (error) {
      return {
        outcome: 'failure',
        code: localErrorCode(error, 'release-local-adapter-failed'),
      };
    }
  };
}

type FileStat = NonNullable<ReturnType<typeof lstatSync>>;
type DescriptorStat = NonNullable<ReturnType<typeof fstatSync>>;

interface PinnedDirectory {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: DescriptorStat;
}

function sameIdentity(left: FileStat, right: DescriptorStat | FileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function pinDirectory(path: string): PinnedDirectory {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error('release-destination-path-unsafe');
  }
  const descriptor = openReadOnlyNoFollowSync(path, true);
  const identity = fstatSync(descriptor);
  if (!sameIdentity(before, identity)) {
    closeReadOnlySync(descriptor);
    throw new Error('release-destination-identity-race');
  }
  return { path, descriptor, identity };
}

function assertPinnedDirectory(pin: PinnedDirectory): void {
  const descriptorIdentity = fstatSync(pin.descriptor);
  const pathIdentity = lstatSync(pin.path);
  if (
    !sameIdentity(pathIdentity, pin.identity) ||
    !sameIdentity(pathIdentity, descriptorIdentity)
  ) {
    throw new Error('release-destination-identity-race');
  }
}

function closePins(pins: readonly PinnedDirectory[]): void {
  for (const pin of pins.toReversed()) closeReadOnlySync(pin.descriptor);
}

function destinationPins(
  repoRoot: string,
  requested: string,
): {
  readonly root: string;
  readonly destination: string;
  readonly parent: PinnedDirectory;
  readonly pins: readonly PinnedDirectory[];
} {
  const root = realpathSync(resolve(repoRoot));
  if (isAbsolute(requested)) throw new Error('release-destination-path-unsafe');
  const destination = resolve(root, requested);
  const escaped = relative(root, destination);
  if (escaped === '' || escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error('release-destination-path-unsafe');
  }
  try {
    lstatSync(destination);
    throw new Error('release-destination-already-exists');
  } catch (error) {
    if (error instanceof Error && error.message === 'release-destination-already-exists')
      throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parentPath = dirname(destination);
  const parentRelative = relative(root, parentPath);
  const pins: PinnedDirectory[] = [];
  let cursor = root;
  try {
    pins.push(pinDirectory(cursor));
    for (const part of parentRelative.split(sep)) {
      if (part.length === 0) continue;
      cursor = join(cursor, part);
      pins.push(pinDirectory(cursor));
    }
    const parent = pins.at(-1);
    if (parent === undefined || parent.path !== parentPath) {
      throw new Error('release-destination-path-unsafe');
    }
    return { root, destination, parent, pins };
  } catch (error) {
    closePins(pins);
    throw error;
  }
}

function fsyncPath(path: string, directory = false): void {
  const descriptor = openSync(
    path,
    fileOpenConstants.O_RDONLY |
      (fileOpenConstants.O_NOFOLLOW ?? 0) |
      (directory ? (fileOpenConstants.O_DIRECTORY ?? 0) : 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createPinnedChildDirectory(
  parent: PinnedDirectory,
  name: string,
  pins: PinnedDirectory[],
): PinnedDirectory {
  if (name.length === 0 || name === '.' || name === '..' || basename(name) !== name) {
    throw new Error('release-destination-path-unsafe');
  }
  assertPinnedDirectory(parent);
  const path = join(parent.path, name);
  mkdirSync(path, { mode: 0o700 });
  const pin = pinDirectory(path);
  pins.push(pin);
  assertPinnedDirectory(parent);
  return pin;
}

function writePinnedFile(
  parent: PinnedDirectory,
  name: string,
  bytes: Buffer,
  executable = false,
): void {
  if (name.length === 0 || name === '.' || name === '..' || basename(name) !== name) {
    throw new Error('release-candidate-snapshot-path-invalid');
  }
  assertPinnedDirectory(parent);
  const path = join(parent.path, name);
  writeFileSync(path, bytes, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
  chmodSync(path, executable ? 0o755 : 0o644);
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('release-staging-file-identity-invalid');
  }
  const descriptor = openReadOnlyNoFollowSync(path);
  try {
    const opened = fstatSync(descriptor);
    if (!sameIdentity(before, opened) || sha256(readFileSync(descriptor)) !== sha256(bytes)) {
      throw new Error('release-staging-file-identity-invalid');
    }
  } finally {
    closeReadOnlySync(descriptor);
  }
  fsyncPath(path);
  assertPinnedDirectory(parent);
}

function readPinnedFile(parent: PinnedDirectory, name: string): Buffer {
  if (name.length === 0 || basename(name) !== name) {
    throw new Error('release-staging-file-identity-invalid');
  }
  assertPinnedDirectory(parent);
  const path = join(parent.path, name);
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('release-staging-file-identity-invalid');
  }
  const descriptor = openReadOnlyNoFollowSync(path);
  try {
    const opened = fstatSync(descriptor);
    if (!sameIdentity(before, opened) || opened.nlink !== 1) {
      throw new Error('release-staging-file-identity-invalid');
    }
    const bytes = readFileSync(descriptor);
    if (!sameIdentity(lstatSync(path), opened)) {
      throw new Error('release-staging-file-identity-invalid');
    }
    return bytes;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function safeRemoveDirectory(path: string, identity: FileStat): void {
  let observed: FileStat;
  try {
    observed = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sameIdentity(observed, identity) || observed.isSymbolicLink() || !observed.isDirectory()) {
    throw new Error('release-destination-identity-race');
  }
  rmSync(path, { recursive: true, force: false });
}

function packedFilename(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('release-pack-output-invalid');
  const first = object(parsed[0]);
  if (typeof first['filename'] !== 'string' || first['filename'].length === 0) {
    throw new Error('release-pack-output-invalid');
  }
  return first['filename'];
}

function packOnce(
  npm: ResolvedTaskExecutable,
  candidate: ReleaseLifecycleRequest['candidate_locator'],
  packageRoot: string,
  output: PinnedDirectory,
): { readonly path: string; readonly bytes: Buffer } {
  const result = spawnSync(
    npm.path,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', output.path],
    bindReleaseToolProcessOptions(
      {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
      {
        candidate: { commit: candidate.commit, tree: candidate.tree },
        tool: 'npm',
        executable: npm,
        cwd: packageRoot,
        output: output.path,
      },
    ),
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('release-pack-failed');
  }
  const filename = basename(packedFilename(result.stdout));
  const path = join(output.path, filename);
  if (!existsSync(path)) throw new Error('release-pack-output-missing');
  return { path, bytes: readPinnedFile(output, filename) };
}

interface CandidatePackageSnapshot {
  readonly release_unit: string;
  readonly package_id: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly package_prefix: string;
  readonly manifest_bytes: Buffer;
  readonly entries: ReturnType<typeof readExactGitTreeSync>;
  readonly projection_digest: string;
}

function exactCandidatePackages(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
): readonly CandidatePackageSnapshot[] {
  const snapshots: CandidatePackageSnapshot[] = [];
  for (const unit of request.candidate_locator.release_units) {
    for (const pkg of unit.package_roster) {
      const packagePrefix = dirname(pkg.manifest_path).replaceAll('\\', '/');
      const entries = readExactGitTreeSync(
        context.repo_root,
        request.candidate_locator.commit,
        request.candidate_locator.tree,
        packagePrefix,
      );
      if (entries.some((entry) => entry.mode === '120000')) {
        throw new Error('release-candidate-snapshot-unsupported-entry');
      }
      const manifest = entries.find((entry) => entry.path === pkg.manifest_path);
      if (manifest === undefined || sha256(manifest.bytes) !== pkg.manifest_digest_sha256) {
        throw new Error('release-package-manifest-identity-mismatch');
      }
      const manifestDocument = object(JSON.parse(manifest.bytes.toString('utf8')) as unknown);
      if (
        manifestDocument['name'] !== pkg.package_id ||
        manifestDocument['version'] !== unit.version
      ) {
        throw new Error('release-package-manifest-identity-mismatch');
      }
      const projection = entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        object_id: entry.object_id,
        sha256: sha256(entry.bytes),
        size_bytes: entry.bytes.byteLength,
      }));
      snapshots.push({
        release_unit: unit.release_unit,
        package_id: pkg.package_id,
        version: unit.version,
        manifest_path: pkg.manifest_path,
        package_prefix: packagePrefix,
        manifest_bytes: manifest.bytes,
        entries,
        projection_digest: canonicalSha256({
          candidate: {
            commit: request.candidate_locator.commit,
            tree: request.candidate_locator.tree,
          },
          release_unit: unit.release_unit,
          package_id: pkg.package_id,
          entries: projection,
        }),
      });
    }
  }
  return snapshots;
}

function snapshotKey(releaseUnit: string, packageId: string): string {
  return `${releaseUnit}\0${packageId}`;
}

function verifyStagedPopulation(
  publishRoot: PinnedDirectory,
  artifacts: readonly ReleaseStateMaterial['artifacts'][number][],
): void {
  const expected = artifacts
    .filter((value) => value.kind === 'package-tarball' || value.kind === 'sbom')
    .map((value) => ({
      filename: basename(value.path),
      sha256: value.sha256,
      size_bytes: value.size_bytes,
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename, 'en'));
  assertPinnedDirectory(publishRoot);
  const observed = readdirSync(publishRoot.path, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('release-staging-file-identity-invalid');
      }
      const path = join(publishRoot.path, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error('release-staging-file-identity-invalid');
      }
      const bytes = readPinnedFile(publishRoot, entry.name);
      return { filename: entry.name, sha256: sha256(bytes), size_bytes: bytes.byteLength };
    })
    .sort((left, right) => left.filename.localeCompare(right.filename, 'en'));
  if (canonicalSha256(observed) !== canonicalSha256(expected)) {
    throw new Error('release-staging-population-mismatch');
  }
}

function materializePackageSnapshot(
  snapshot: CandidatePackageSnapshot,
  root: PinnedDirectory,
  pins: PinnedDirectory[],
): void {
  for (const entry of snapshot.entries) {
    const relativePath =
      snapshot.package_prefix === '.'
        ? entry.path
        : entry.path.slice(snapshot.package_prefix.length + 1);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('release-candidate-snapshot-path-invalid');
    }
    const parts = relativePath.split('/');
    const filename = parts.pop();
    if (filename === undefined) throw new Error('release-candidate-snapshot-path-invalid');
    let parent = root;
    for (const part of parts) {
      const path = join(parent.path, part);
      const existing = pins.find((pin) => pin.path === path);
      parent = existing ?? createPinnedChildDirectory(parent, part, pins);
      assertPinnedDirectory(parent);
    }
    writePinnedFile(parent, filename, entry.bytes, entry.mode === '100755');
  }
}

function safeArtifactName(packageId: string): string {
  return packageId
    .replace(/^@/u, '')
    .replaceAll('/', '-')
    .replaceAll(/[^A-Za-z0-9._-]/gu, '-');
}

function prepareProvider(context: BuiltInReleaseLifecycleLocalContext): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    let stageRoot = '';
    let stageIdentity: FileStat | undefined;
    let destinationIdentity: FileStat | undefined;
    let committed = false;
    let pins: PinnedDirectory[] = [];
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const destination = request.destination;
      if (destination?.kind !== 'local-staging') {
        throw new Error('release-destination-path-unsafe');
      }
      const target = destinationPins(context.repo_root, destination.exact_identifier);
      pins = [...target.pins];
      const destinationPath = relative(target.root, target.destination).replaceAll('\\', '/');
      const snapshots = exactCandidatePackages(context, request);
      const names = snapshots.map(
        (snapshot) => `${safeArtifactName(snapshot.package_id)}-${snapshot.version}`,
      );
      if (new Set(names).size !== names.length) {
        throw new Error('release-artifact-name-collision');
      }
      const npm = resolveTaskExecutable(target.root, 'npm');
      stageRoot = mkdtempSync(join(target.parent.path, '.devai-release-prepare-'));
      chmodSync(stageRoot, 0o700);
      stageIdentity = lstatSync(stageRoot);
      const stagePin = pinDirectory(stageRoot);
      pins.push(stagePin);
      const publishPin = createPinnedChildDirectory(stagePin, 'publish', pins);
      const snapshotsPin = createPinnedChildDirectory(stagePin, 'snapshots', pins);
      const publishRoot = publishPin.path;
      const snapshotRoots = new Map<string, PinnedDirectory>();
      snapshots.forEach((snapshot, index) => {
        const snapshotRoot = createPinnedChildDirectory(
          snapshotsPin,
          String(index).padStart(4, '0'),
          pins,
        );
        materializePackageSnapshot(snapshot, snapshotRoot, pins);
        snapshotRoots.set(snapshotKey(snapshot.release_unit, snapshot.package_id), snapshotRoot);
      });
      const artifacts: ReleaseStateMaterial['artifacts'][number][] = [];
      const preparedUnits = request.candidate_locator.release_units.map((unit) => ({
        release_unit: unit.release_unit,
        version: unit.version,
        packages: unit.package_roster.map((pkg) => {
          const snapshot = snapshots.find(
            (value) =>
              value.release_unit === unit.release_unit && value.package_id === pkg.package_id,
          );
          const packageRoot = snapshotRoots.get(snapshotKey(unit.release_unit, pkg.package_id));
          if (snapshot === undefined || packageRoot === undefined) {
            throw new Error('release-release-unit-bijection-invalid');
          }
          const firstRoot = createPinnedChildDirectory(
            stagePin,
            `pack-${safeArtifactName(pkg.package_id)}-first`,
            pins,
          );
          const secondRoot = createPinnedChildDirectory(
            stagePin,
            `pack-${safeArtifactName(pkg.package_id)}-second`,
            pins,
          );
          const first = packOnce(npm, request.candidate_locator, packageRoot.path, firstRoot);
          const second = packOnce(npm, request.candidate_locator, packageRoot.path, secondRoot);
          const observedNpm = resolveTaskExecutable(target.root, 'npm');
          if (observedNpm.path !== npm.path || observedNpm.sha256 !== npm.sha256) {
            throw new Error('release-toolchain-identity-mismatch');
          }
          const firstBytes = first.bytes;
          const secondBytes = second.bytes;
          if (sha256(firstBytes) !== sha256(secondBytes)) {
            throw new Error('release-pack-nondeterministic');
          }
          const name = `${safeArtifactName(pkg.package_id)}-${unit.version}`;
          writePinnedFile(publishPin, `${name}.tgz`, firstBytes);
          const tarball = artifact(`${destinationPath}/${name}.tgz`, firstBytes);
          const sbomDocument = {
            bomFormat: 'CycloneDX',
            specVersion: '1.6',
            version: 1,
            metadata: {
              component: {
                type: 'library',
                name: pkg.package_id,
                version: unit.version,
                hashes: [
                  { alg: 'SHA-256', content: tarball.sha256 },
                  { alg: 'SHA-256', content: snapshot.projection_digest },
                  { alg: 'SHA-256', content: npm.sha256 },
                ],
              },
            },
          };
          const sbomBytes = Buffer.from(`${canonicalJson(sbomDocument)}\n`);
          writePinnedFile(publishPin, `${name}.cdx.json`, sbomBytes);
          const sbom = artifact(`${destinationPath}/${name}.cdx.json`, sbomBytes);
          artifacts.push(
            {
              kind: 'manifest',
              ...artifact(snapshot.manifest_path, snapshot.manifest_bytes),
            },
            { kind: 'package-tarball', ...tarball },
            { kind: 'sbom', ...sbom },
          );
          return {
            package_id: pkg.package_id,
            manifest: artifact(snapshot.manifest_path, snapshot.manifest_bytes),
            tarball,
            sbom,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
          };
        }),
      }));
      const sortedArtifacts = artifacts.sort((left, right) =>
        `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`, 'en'),
      );
      const snapshotBinding = snapshots.map((snapshot) => ({
        release_unit: snapshot.release_unit,
        package_id: snapshot.package_id,
        projection_digest: snapshot.projection_digest,
      }));
      verifyStagedPopulation(publishPin, sortedArtifacts);
      fsyncPath(publishRoot, true);
      assertPinnedDirectory(target.parent);
      if (lstatSync(stageRoot).dev !== target.parent.identity.dev) {
        throw new Error('release-destination-cross-device');
      }
      const dispose = (): void => {
        try {
          if (stageIdentity !== undefined) safeRemoveDirectory(stageRoot, stageIdentity);
        } finally {
          closePins(pins);
          pins = [];
        }
      };
      const rollback = (): void => {
        if (committed && destinationIdentity !== undefined) {
          safeRemoveDirectory(target.destination, destinationIdentity);
          fsyncPath(target.parent.path, true);
          committed = false;
        }
      };
      return {
        outcome: 'success',
        material: {
          release_units: preparedUnits,
          inputs: [
            ...materialInputs(receipts),
            {
              kind: 'toolchain',
              path: 'toolchain/npm',
              sha256: npm.sha256,
            },
          ].sort((left, right) =>
            `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`, 'en'),
          ),
          evidence: {
            manifest_digest_sha256: canonicalSha256({
              candidate: request.candidate_locator,
              snapshots: snapshotBinding,
              npm,
              artifacts: sortedArtifacts,
            }),
            receipt_digests: receipts
              .map((receipt) => String(receipt['receipt_digest_sha256']))
              .sort(),
            independently_checkable: true,
          },
          artifacts: sortedArtifacts,
        },
        transaction: {
          commit: () => {
            for (const pin of pins) assertPinnedDirectory(pin);
            verifyStagedPopulation(publishPin, sortedArtifacts);
            try {
              lstatSync(target.destination);
              throw new Error('release-destination-already-exists');
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === 'release-destination-already-exists'
              ) {
                throw error;
              }
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            const publishIdentity = lstatSync(publishRoot);
            if (publishIdentity.isSymbolicLink() || !publishIdentity.isDirectory()) {
              throw new Error('release-destination-path-unsafe');
            }
            renameSync(publishRoot, target.destination);
            destinationIdentity = publishIdentity;
            committed = true;
            const observedDestination = lstatSync(target.destination);
            if (!sameIdentity(observedDestination, publishIdentity)) {
              throw new Error('release-destination-identity-race');
            }
            fsyncPath(target.parent.path, true);
            assertPinnedDirectory(target.parent);
          },
          rollback,
          dispose,
        },
      };
    } catch (error) {
      try {
        if (committed && destinationIdentity !== undefined && request.destination !== undefined) {
          const destination = resolve(context.repo_root, request.destination.exact_identifier);
          safeRemoveDirectory(destination, destinationIdentity);
        }
        if (stageIdentity !== undefined) safeRemoveDirectory(stageRoot, stageIdentity);
      } finally {
        closePins(pins);
      }
      return {
        outcome: 'failure',
        code: localErrorCode(error, 'release-prepare-failed'),
      };
    }
  };
}

/** Production local adapters. Protected providers are intentionally absent. */
export function builtInReleaseLifecycleLocalProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: ReleaseLifecycleRequest['action_id'],
): ReleaseProvider | undefined {
  if (action === 'release preflight' || action === 'release certify') {
    return checkProvider(context, action);
  }
  if (action === 'release prepare') return prepareProvider(context);
  return undefined;
}
