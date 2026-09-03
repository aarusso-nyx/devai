import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { lstatSync, readExactGitTreeSync, readdirSync } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  parseTaskDescriptor,
  runCheckTasks,
  type CheckRunnerReport,
  type TaskDescriptor,
} from './check-runner/index.js';
import type {
  CertificationPackageEntry,
  CertificationPackageEntryManifest,
  PackageEvidence,
  ReleaseLifecycleRequest,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  finalizeCertificationManifest,
  finalizeCertificationReceipt,
} from './release-prepare-kernel.js';

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

function artifact(path: string, bytes: Buffer) {
  return { path, sha256: sha256(bytes), size_bytes: bytes.byteLength };
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

function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function selectedByFiles(path: string, files: readonly string[]): boolean {
  return (
    path === 'package.json' || files.some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function packageFiles(manifest: Json): readonly string[] {
  const files = manifest['files'];
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some(
      (path) =>
        typeof path !== 'string' ||
        !safeRelative(path) ||
        /[*?[\]{}!]/u.test(path) ||
        path.endsWith('/'),
    ) ||
    new Set(files).size !== files.length
  ) {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  return [...files].sort() as string[];
}

function walkSelectedFiles(
  context: BuiltInReleaseLifecycleLocalContext,
  packagePrefix: string,
  files: readonly string[],
): readonly {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: '100644' | '100755';
}[] {
  const result: { path: string; bytes: Buffer; mode: '100644' | '100755' }[] = [];
  const root = resolve(context.repo_root, packagePrefix);
  const visit = (relativePath: string): void => {
    const absolute = resolve(root, relativePath);
    const escaped = relative(root, absolute);
    if (escaped === '..' || escaped.startsWith(`..${sep}`)) {
      throw new Error('release-candidate-snapshot-path-invalid');
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('release-candidate-snapshot-unsupported-entry');
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relativePath}/${name}`);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('release-candidate-snapshot-unsupported-entry');
    }
    const normalized = relativePath.replace(/^\.\//u, '');
    result.push({
      path: normalized,
      bytes: context.read_contained_bytes(
        packagePrefix === '.' ? normalized : `${packagePrefix}/${normalized}`,
      ),
      mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
    });
  };
  for (const file of files) visit(file);
  return result;
}

function certificationPackages(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
  reportGroups: readonly (readonly CheckRunnerReport[])[],
): readonly {
  readonly release_unit: string;
  readonly version: string;
  readonly packages: readonly PackageEvidence[];
}[] {
  return request.candidate_locator.release_units.map((unit, unitIndex) => {
    const reports = reportGroups[unitIndex];
    const certified = reports?.at(-1);
    if (certified?.receipt === undefined) throw new Error('release-certify-failed');
    return {
      release_unit: unit.release_unit,
      version: unit.version,
      packages: unit.package_roster.map((pkg) => {
        const packagePrefix = dirname(pkg.manifest_path).replaceAll('\\', '/');
        const gitEntries = readExactGitTreeSync(
          context.repo_root,
          request.candidate_locator.commit,
          request.candidate_locator.tree,
          packagePrefix,
        );
        if (gitEntries.some((entry) => entry.mode !== '100644' && entry.mode !== '100755')) {
          throw new Error('release-candidate-snapshot-unsupported-entry');
        }
        const manifestEntry = gitEntries.find((entry) => entry.path === pkg.manifest_path);
        if (
          manifestEntry === undefined ||
          sha256(manifestEntry.bytes) !== pkg.manifest_digest_sha256
        ) {
          throw new Error('release-package-manifest-identity-mismatch');
        }
        const manifestDocument = object(
          JSON.parse(manifestEntry.bytes.toString('utf8')) as unknown,
        );
        if (
          manifestDocument['name'] !== pkg.package_id ||
          manifestDocument['version'] !== unit.version
        ) {
          throw new Error('release-package-manifest-identity-mismatch');
        }
        const files = packageFiles(manifestDocument);
        const packageRelative = (path: string): string =>
          packagePrefix === '.' ? path : path.slice(packagePrefix.length + 1);
        const entries = new Map<string, CertificationPackageEntry>();
        for (const entry of gitEntries) {
          const path = packageRelative(entry.path);
          if (!selectedByFiles(path, files)) continue;
          entries.set(path, {
            path,
            mode: entry.mode as '100644' | '100755',
            size_bytes: entry.bytes.byteLength,
            sha256: sha256(entry.bytes),
            immutable_blob_locator: { kind: 'git-object', object_id: entry.object_id },
          });
        }
        for (const entry of walkSelectedFiles(context, packagePrefix, files)) {
          if (entries.has(entry.path)) continue;
          const digest = sha256(entry.bytes);
          const certificationEvidenceReceipt = finalizeCertificationReceipt({
            candidate_commit: request.candidate_locator.commit,
            candidate_tree: request.candidate_locator.tree,
            task_policy_digest_sha256: certified.plan.taskPolicyDigest,
            package_id: pkg.package_id,
            output_blob_sha256: digest,
          });
          entries.set(entry.path, {
            path: entry.path,
            mode: entry.mode,
            size_bytes: entry.bytes.byteLength,
            sha256: digest,
            immutable_blob_locator: {
              kind: 'generated-output',
              output_blob_sha256: digest,
              certification_evidence_receipt: certificationEvidenceReceipt,
            },
          });
        }
        const sortedEntries = [...entries.values()].sort((left, right) =>
          Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
        );
        const draft = {
          candidate: {
            commit: request.candidate_locator.commit,
            tree: request.candidate_locator.tree,
          },
          task_policy_digest_sha256: certified.plan.taskPolicyDigest,
          package_id: pkg.package_id,
          package_version: unit.version,
          entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse' as const,
          manifest_digest_contract: {
            domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0' as const,
            payload:
              'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes' as const,
            canonicalization: 'rfc8785-jcs' as const,
            algorithm: 'sha256' as const,
          },
          entries: sortedEntries,
        };
        const certificationManifest: CertificationPackageEntryManifest =
          finalizeCertificationManifest(draft);
        return {
          package_id: pkg.package_id,
          manifest: artifact(pkg.manifest_path, manifestEntry.bytes),
          tarball: null,
          sbom: null,
          evidence_manifest: null,
          provider_result: null,
          trust: null,
          certification_manifest: certificationManifest,
        };
      }),
    };
  });
}

function preflightPackages(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
) {
  return request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => {
      const entries = readExactGitTreeSync(
        context.repo_root,
        request.candidate_locator.commit,
        request.candidate_locator.tree,
        pkg.manifest_path,
      );
      const manifest = entries.find((entry) => entry.path === pkg.manifest_path);
      if (manifest === undefined || sha256(manifest.bytes) !== pkg.manifest_digest_sha256) {
        throw new Error('release-package-manifest-identity-mismatch');
      }
      return {
        package_id: pkg.package_id,
        manifest: artifact(pkg.manifest_path, manifest.bytes),
        tarball: null,
        sbom: null,
        evidence_manifest: null,
        provider_result: null,
        trust: null,
      };
    }),
  }));
}

function checkProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: 'release preflight' | 'release certify',
): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const stage = action === 'release preflight' ? 'preflight' : 'certify';
      const groups = receipts.map((receipt) => runStage(context, request, receipt, stage));
      const reports = groups.flat();
      if (
        reports.some(
          (report) => !checkPassed(report, report.receipt === undefined ? 'preflight' : 'certify'),
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
          release_units:
            action === 'release certify'
              ? certificationPackages(context, request, groups)
              : preflightPackages(context, request),
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
      return { outcome: 'failure', code: localErrorCode(error, 'release-local-adapter-failed') };
    }
  };
}

/** Production local adapters. Prepare and protected providers require trusted host injection. */
export function builtInReleaseLifecycleLocalProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: ReleaseLifecycleRequest['action_id'],
): ReleaseProvider | undefined {
  if (action === 'release preflight' || action === 'release certify') {
    return checkProvider(context, action);
  }
  return undefined;
}
