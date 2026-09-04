import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  assertCliInvocationIdle,
  invokeDevaiCli,
  type CliInvocationResult,
} from '../cli-runtime.js';
import { installReleaseLifecycleCommandAdapters } from '../commands/release/lifecycle.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import {
  isVerifiedReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
} from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import {
  resolveReleasePolicySnapshot,
  type ReleasePolicyExpectedIdentity,
} from './release-policy-resolution.js';
import { createReleasePolicyClosure, type ReleasePolicyClosure } from './release-policy-closure.js';
import { buildResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { canonicalContainerPath } from './container-archive.js';
import {
  createContainerReleaseCertificationAdapters,
  type ContainerReleaseCertificationOptions,
  type ProtectedReleasePlanMaterial,
} from './release-certification-provider.js';
import {
  createReleaseCertificationEvidenceStore,
  type ReleaseCertificationEvidenceStoreOptions,
} from './release-evidence-store.js';
import {
  createReleaseArtifactStore,
  type ReleaseArtifactStoreOptions,
} from './release-artifact-store.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  type ImmutableReleaseContentSource,
} from './release-prepare-kernel.js';
import {
  validateReleaseLifecycleRequest,
  type PublicationSignatureVerifier,
  type ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';

/** A locator and raw-byte identity approved by the operator before it is read. */
export interface ProtectedReleaseInputFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ProtectedReleaseHostRunnerControls {
  /** Use the exact object returned by bootstrapReleaseHost, never a source-mode snapshot. */
  readonly installed_package: ReleasePackageSnapshot;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly expected: ReleasePolicyExpectedIdentity;
  readonly producer?: Parameters<typeof resolveReleasePolicySnapshot>[0]['producer'];
  readonly repository_root: string;
  /** Must be the registered .devai/state/release-lifecycle namespace or a descendant. */
  readonly state_root: string;
  readonly maximum_input_bytes: number;
  readonly unit: {
    readonly intent: unknown;
    readonly packages: readonly {
      readonly manifest_path: string;
      readonly source_entries: readonly string[];
      readonly generated_entries: readonly { readonly path: string; readonly task_node: string }[];
    }[];
    /** Genuine prior protected result for a restarted certification process; independently reverified. */
    readonly preflight_receipt?: unknown;
  };
  readonly execution: Pick<
    ContainerReleaseCertificationOptions,
    'controls' | 'dependencies' | 'environment' | 'toolchain' | 'timeout_ms'
  >;
  readonly certification_store: ReleaseCertificationEvidenceStoreOptions;
  readonly artifact_store: Omit<ReleaseArtifactStoreOptions, 'binding'>;
  readonly publication_signature_verifier: PublicationSignatureVerifier;
  /** Deliberately unfinished delivery slots, not permission or an ambient fallback. */
  readonly later_stages: { readonly export: 'unavailable'; readonly offline_verify: 'unavailable' };
}

interface InvocationAuthority {
  /** No role is inferred by this runner; the normal CLI checks this explicit declaration. */
  readonly as_role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly write: boolean;
}

export type ProtectedReleaseHostInvocation =
  | { readonly action: 'release plan'; readonly intent: ProtectedReleaseInputFile }
  | (InvocationAuthority & {
      readonly action: 'release preflight' | 'release certify' | 'release prepare';
      readonly request: ProtectedReleaseInputFile;
    })
  | {
      readonly action: 'release resume';
      readonly request: ProtectedReleaseInputFile;
      readonly receipts: ProtectedReleaseInputFile;
      readonly publication_receipt?: ProtectedReleaseInputFile;
    };

export interface ProtectedReleaseHostRunner {
  /** Copies, not live provider state. These methods do not persist receipts or advance the lifecycle. */
  readonly readPlan: () => Readonly<Record<string, unknown>>;
  readonly readPolicyClosure: () => ReleasePolicyClosure;
  readonly invoke: (input: ProtectedReleaseHostInvocation) => Promise<CliInvocationResult>;
}

const INVALID = 'release-host-controls-invalid';
const INPUT_INVALID = 'release-host-input-mismatch';
let installed = false;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fail(code = INVALID): never {
  throw new Error(code);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key))
  )
    fail();
}
function path(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) fail();
  return resolve(value);
}
function regularInput(input: ProtectedReleaseInputFile, maximum: number): unknown {
  try {
    closed(input, ['path', 'sha256']);
    const filename = path(input.path);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) fail();
    const before = lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) fail();
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const equal = (stat: typeof before) =>
      ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
        (key) => stat[key as keyof typeof stat] === before[key as keyof typeof before],
      );
    try {
      if (!equal(fstatSync(descriptor, { bigint: true }))) fail();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail();
        offset += count;
      }
      if (
        readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 ||
        !equal(fstatSync(descriptor, { bigint: true })) ||
        !equal(lstatSync(filename, { bigint: true })) ||
        hash(bytes) !== input.sha256
      )
        fail();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return fail(INPUT_INVALID);
  }
}

/**
 * Package-owned external-host composition, called on the runtime returned by the
 * approved bootstrap/provisioner. Controls and producer approval belong to the
 * operator, never a candidate, environment loader, request or task subprocess.
 * Construct once before invoking the CLI. This installs real container and durable
 * store adapters; it creates no directories and writes no intent/request files.
 *
 * One release unit is supported here because the current prepare capacity binding
 * requires one plan receipt. Its complete package roster and the profile's full
 * mutation/task populations are preserved; the multi-unit kernels are unchanged.
 * Export, offline verification and remote publication are not implemented here.
 *
 * Invoke sequentially with operator-prepared digest-pinned files. No auto retry,
 * next-action dispatch, adapter disposal, cwd change or authority inference occurs.
 * The operator owns input paths for the invocation lifetime: descriptor revalidation
 * detects races but is not native openat containment or protection against ABA.
 */
export function createProtectedReleaseHostRunner(
  input: ProtectedReleaseHostRunnerControls,
): ProtectedReleaseHostRunner {
  assertCliInvocationIdle();
  if (installed) fail('release-host-runner-already-installed');
  closed(
    input,
    [
      'installed_package',
      'candidate',
      'expected',
      'repository_root',
      'state_root',
      'maximum_input_bytes',
      'unit',
      'execution',
      'certification_store',
      'artifact_store',
      'publication_signature_verifier',
      'later_stages',
    ],
    ['producer'],
  );
  assertBoundReleaseHostPackageSnapshot(input.installed_package);
  if (!isVerifiedReleaseCandidateSnapshot(input.candidate)) fail();
  closed(input.later_stages, ['export', 'offline_verify']);
  if (
    input.later_stages.export !== 'unavailable' ||
    input.later_stages.offline_verify !== 'unavailable' ||
    typeof input.publication_signature_verifier !== 'function' ||
    !Number.isSafeInteger(input.maximum_input_bytes) ||
    input.maximum_input_bytes < 1 ||
    input.maximum_input_bytes > 0x7fffffff
  )
    fail();
  closed(input.unit, ['intent', 'packages'], ['preflight_receipt']);
  closed(input.execution, ['controls', 'environment', 'toolchain', 'timeout_ms'], ['dependencies']);
  const root = realpathSync(path(input.repository_root));
  const stateRoot = path(input.state_root);
  const stateNamespace = resolve(root, '.devai/state/release-lifecycle');
  if (stateRoot !== stateNamespace && !stateRoot.startsWith(`${stateNamespace}${sep}`)) fail();
  const cwd = process.cwd();
  const maximum = input.maximum_input_bytes;
  const verifySignature = input.publication_signature_verifier;
  const candidate = input.candidate;
  const repository = copy(candidate.repository);
  const unit = copy(input.unit);
  const resolution = resolveReleasePolicySnapshot({
    expected: input.expected,
    installed_package: input.installed_package,
    candidate,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
  });
  const receipt = buildResolvedReleasePlanReceipt({ intent: unit.intent, resolution });
  if (receipt.verdict !== 'pass' || !Array.isArray(unit.packages) || unit.packages.length === 0)
    fail();
  const packages = unit.packages
    .map((pkg) => {
      closed(pkg, ['manifest_path', 'source_entries', 'generated_entries']);
      if (
        !canonicalContainerPath(pkg.manifest_path) ||
        pkg.manifest_path.split('/').at(-1) !== 'package.json' ||
        !Array.isArray(pkg.source_entries) ||
        !Array.isArray(pkg.generated_entries) ||
        !pkg.source_entries.includes('package.json')
      )
        fail();
      const selectedPaths = [...pkg.source_entries];
      for (const output of pkg.generated_entries) {
        closed(output, ['path', 'task_node']);
        if (
          typeof output.task_node !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/u.test(output.task_node)
        )
          fail();
        selectedPaths.push(output.path);
      }
      if (
        selectedPaths.some((entry) => !canonicalContainerPath(entry)) ||
        new Set(selectedPaths).size !== selectedPaths.length
      )
        fail();
      const prefix = pkg.manifest_path.slice(0, -'package.json'.length);
      for (const entry of pkg.source_entries) candidate.read(`${prefix}${entry}`);
      const raw = candidate.read(pkg.manifest_path);
      const manifest = JSON.parse(raw.toString('utf8')) as { name?: unknown; version?: unknown };
      if (
        typeof manifest.name !== 'string' ||
        manifest.version !== receipt.candidate.version ||
        !pkg.source_entries.includes('package.json')
      )
        fail();
      return {
        mapping: {
          package_id: manifest.name,
          source_entries: pkg.source_entries,
          generated_entries: pkg.generated_entries,
        },
        roster: {
          package_id: manifest.name,
          manifest_path: pkg.manifest_path,
          manifest_digest_sha256: hash(raw),
        },
      };
    })
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.roster.package_id), Buffer.from(b.roster.package_id)),
    );
  if (
    new Set(packages.map((pkg) => pkg.roster.package_id)).size !== packages.length ||
    new Set(packages.map((pkg) => pkg.roster.manifest_path)).size !== packages.length
  )
    fail();
  const candidateLocator = {
    commit: repository.commit,
    tree: repository.tree,
    release_units: [
      {
        release_unit: receipt.candidate.release_unit,
        version: receipt.candidate.version,
        package_roster: packages.map((pkg) => pkg.roster),
      },
    ],
  };
  // Copy the complete verified population once; no later Git or pathname reads in
  // content resolution. The existing provider still rechecks its exact checkout.
  const objects = candidate.readProof(candidate.paths);
  const format = repository.commit.length === 40 ? 'sha1' : 'sha256';
  const assertRepository = (value: unknown) => {
    if (!same(value, repository)) fail(INPUT_INVALID);
  };
  const git: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'> = {
    readGitObject(value) {
      assertRepository(value.repository);
      const object = objects.get(value.object_id);
      if (value.object_format !== format || object?.type !== value.type) return fail(INPUT_INVALID);
      return Buffer.from(object.bytes);
    },
    readGitBlob(value) {
      assertRepository(value.repository);
      const locator = value.locator;
      const object = objects.get(value.object_id);
      if (
        value.candidate.commit !== repository.commit ||
        value.candidate.tree !== repository.tree ||
        locator.repository !== repository.id ||
        locator.commit !== repository.commit ||
        locator.tree !== repository.tree ||
        locator.object_format !== format ||
        locator.object_id !== value.object_id ||
        object?.type !== 'blob'
      )
        return fail(INPUT_INVALID);
      const bytes = candidate.read(locator.path);
      if (
        !bytes.equals(Buffer.from(object.bytes)) ||
        bytes.length !== locator.size_bytes ||
        hash(bytes) !== locator.content_digest_sha256
      )
        return fail(INPUT_INVALID);
      return bytes;
    },
  };
  const certificationOptions = copy(input.certification_store);
  const artifactOptions = copy(input.artifact_store);
  if (
    !certificationOptions.repository_roots.includes(root) ||
    !artifactOptions.repository_roots.includes(root) ||
    resolve(certificationOptions.root) === resolve(artifactOptions.root)
  )
    fail();
  const evidence = createReleaseCertificationEvidenceStore(certificationOptions);
  const artifacts = createReleaseArtifactStore({
    ...artifactOptions,
    binding: {
      action_id: 'release prepare',
      repository,
      plan_receipt_digest_sha256: receipt.receipt_digest_sha256,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      sink_id: artifactOptions.sink_id,
    },
  });
  const material: ProtectedReleasePlanMaterial = {
    receipt,
    resolution,
    intent_path: 'invocation',
    intent: unit.intent,
    release_verification_profile: resolution.readInput('release-verification-profile'),
    release_lifecycle_policy: resolution.readInput('release-lifecycle-policy'),
    action_registry: resolution.readInput('action-registry-policy'),
    packages: packages.map((pkg) => pkg.mapping),
    ...(unit.preflight_receipt === undefined ? {} : { preflight_receipt: unit.preflight_receipt }),
  };
  const certification = createContainerReleaseCertificationAdapters({
    ...input.execution,
    repository_root: root,
    repository_id: repository.id,
    plans: [material],
    content_source: git,
    evidence_sink: evidence,
  });
  const content: ImmutableReleaseContentSource = {
    ...git,
    readCertificationEvidenceReceipt: (value) => evidence.readCertificationEvidenceReceipt(value),
    readCertificationOutputClosure: (value) => evidence.readCertificationOutputClosure(value),
    readGeneratedBlob: (value) => evidence.readGeneratedBlob(value),
  };
  let pinnedRequest: ReleaseLifecycleRequest | undefined;
  const assertRequest = (request: ReleaseLifecycleRequest) => {
    if (pinnedRequest !== undefined && !same(request, pinnedRequest)) fail(INPUT_INVALID);
    if (
      !same(request.repository_locator, repository) ||
      !same(request.candidate_locator, candidateLocator)
    )
      fail(INPUT_INVALID);
    // Resume forbids receipt locators in its request; its separately pinned
    // receipt-document array below must contain this exact plan instead.
    if (request.action_id === 'release resume') return;
    const plans =
      request.receipt_locators?.filter((value) => value.kind === 'release-plan-receipt') ?? [];
    if (
      plans.length !== 1 ||
      plans[0]?.receipt_id !== receipt.receipt_id ||
      plans[0].receipt_digest_sha256 !== receipt.receipt_digest_sha256
    )
      fail(INPUT_INVALID);
  };
  let active = false;
  const requireActive = () => {
    if (!active || process.cwd() !== cwd || realpathSync(root) !== root)
      fail('release-host-invocation-unbound');
  };
  // Deliberately retain no disposer. One host process owns one immutable binding.
  installed = true;
  installReleaseLifecycleCommandAdapters({
    policy_resolution(value) {
      requireActive();
      if (
        value.repository_id !== repository.id ||
        !same(value.candidate, { commit: repository.commit, tree: repository.tree }) ||
        value.release_unit !== resolution.release_unit
      )
        fail(INPUT_INVALID);
      return resolution;
    },
    preflight_provider(request) {
      requireActive();
      assertRequest(request);
      return certification.preflight_provider;
    },
    certification_provider(request) {
      requireActive();
      assertRequest(request);
      return certification.certification_provider(request);
    },
    prepare_content_source(request) {
      requireActive();
      assertRequest(request);
      return content;
    },
    artifact_sink(request) {
      requireActive();
      assertRequest(request);
      return artifacts;
    },
    artifact_reader(request) {
      requireActive();
      assertRequest(request);
      return artifacts;
    },
    publication_signature_verifier(request) {
      requireActive();
      assertRequest(request);
      return verifySignature;
    },
    provider: () => undefined,
    offline_verification_provider: () => undefined,
    authorization: () => undefined,
    offline_receipt_verifier: () => undefined,
    publication_controls: () => undefined,
  });
  return Object.freeze({
    readPlan: () => copy(receipt),
    readPolicyClosure: () => createReleasePolicyClosure({ plan: receipt, resolution }),
    async invoke(value: ProtectedReleaseHostInvocation) {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      if (process.cwd() !== cwd || realpathSync(root) !== root)
        fail('release-host-working-directory-changed');
      active = true;
      try {
        const action = value.action;
        if (
          ![
            'release plan',
            'release preflight',
            'release certify',
            'release prepare',
            'release resume',
          ].includes(action)
        )
          fail('release-host-stage-unavailable');
        closed(
          value,
          [
            'action',
            ...(['release plan', 'release resume'].includes(action) ? [] : ['as_role', 'write']),
            ...(action === 'release plan' ? ['intent'] : ['request']),
            ...(action === 'release resume' ? ['receipts'] : []),
          ],
          action === 'release resume' ? ['publication_receipt'] : [],
        );
        const invocation = copy(value);
        if (
          'as_role' in invocation &&
          (!['owner', 'architect', 'inspector', 'engineer', 'auditor'].includes(
            invocation.as_role,
          ) ||
            typeof invocation.write !== 'boolean')
        )
          fail();
        const args = [
          ...action.split(' '),
          '--repo-root',
          root,
          ...('as_role' in invocation
            ? ['--as-role', invocation.as_role, ...(invocation.write ? ['--write'] : [])]
            : []),
        ];
        if (invocation.action === 'release plan') {
          if (!same(regularInput(invocation.intent, maximum), unit.intent)) fail(INPUT_INVALID);
          args.push('--intent', invocation.intent.path, '--repository', repository.id);
        } else {
          const request = validateReleaseLifecycleRequest(
            regularInput(invocation.request, maximum),
            invocation.action,
          );
          assertRequest(request);
          pinnedRequest = copy(request);
          args.push('--request', invocation.request.path, '--state-root', stateRoot);
          if (invocation.action === 'release resume') {
            const receipts = regularInput(invocation.receipts, maximum);
            if (!Array.isArray(receipts) || !receipts.some((value) => same(value, receipt)))
              fail(INPUT_INVALID);
            args.push('--receipts', invocation.receipts.path);
            if (invocation.publication_receipt !== undefined) {
              regularInput(invocation.publication_receipt, maximum);
              args.push('--publication-receipt', invocation.publication_receipt.path);
            }
          }
        }
        return await invokeDevaiCli(args);
      } finally {
        pinnedRequest = undefined;
        active = false;
      }
    },
  });
}
