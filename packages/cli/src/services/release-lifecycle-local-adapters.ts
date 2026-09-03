import { createHash } from 'node:crypto';
import { readExactGitTreeSync } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  parseTaskDescriptor,
  runCheckTasks,
  type CheckRunnerReport,
  type TaskDescriptor,
} from './check-runner/index.js';
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
    const stage = 'preflight';
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

function checkPassed(report: CheckRunnerReport): boolean {
  if (report.exitCode !== 0 || report.execution === undefined) return false;
  if (report.execution.some((entry) => entry.outcome !== 'PASS')) return false;
  return report.preflightReceipt !== undefined;
}

function runStage(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
  receipt: Json,
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
  return [preflight];
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

function checkProvider(context: BuiltInReleaseLifecycleLocalContext): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const stage = 'preflight';
      const groups = receipts.map((receipt) => runStage(context, request, receipt));
      const reports = groups.flat();
      if (reports.some((report) => !checkPassed(report))) {
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
          release_units: preflightPackages(context, request),
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
  if (action === 'release preflight') {
    return checkProvider(context);
  }
  return undefined;
}
