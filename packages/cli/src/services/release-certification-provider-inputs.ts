import { realpathSync } from 'node:fs';
import { canonicalJson } from '@devai-nyx/utils';
import { canonicalContainerPath } from './container-archive.js';
import { ProtectedCertificationContainer } from './release-certification-container.js';
import {
  bindProtectedToolchainFixtureContext,
  createProtectedToolchainFixtureContext,
} from './release-toolchain-fixture-compatibility.js';
import { buildReleasePlanReceipt, verifyResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { isVerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import type { TrustedCertificationEvidenceSink } from './release-lifecycle-certification.js';
import {
  RUNTIME_IDENTITY_KEYS,
  compare,
  object,
  snapshot,
  type ContainerReleaseCertificationOptions,
  type Json,
} from './release-certification-provider-state.js';

/** Inputs of the container release adapters; the evidence sink is absent on the diagnostic lane. */
export type ContainerReleaseAdapterInput = Omit<
  ContainerReleaseCertificationOptions,
  'evidence_sink'
> & {
  readonly evidence_sink?: TrustedCertificationEvidenceSink;
};

/** Validate the adapter inputs and capture the plans, container, bindings and runtime identity. */
export function captureContainerReleaseInputs(input: ContainerReleaseAdapterInput) {
  if ([input.toolchain_fixture, input.fixture_context].some((value) => value !== undefined)) {
    throw new Error('MUTATION_OFFLOADED_TO_BEDEL: mutation toolchain fixtures moved to bedel');
  }
  const root = realpathSync(input.repository_root);
  // Keep the opaque resolution from this runtime. JSON copying would erase its
  // provenance brand; all ordinary caller-owned plan data is still snapshotted.
  const plans = input.plans.map(({ resolution, ...plan }) => ({
    ...snapshot(plan),
    resolution,
  }));
  const environment = snapshot(input.environment);
  const toolchain = snapshot(input.toolchain);
  const controls = snapshot(input.controls);
  const container = new ProtectedCertificationContainer(controls, input.dependencies);
  const diagnosticOutputs = snapshot(
    input.diagnostic_outputs === undefined ? [] : input.diagnostic_outputs,
  );
  if (
    !Array.isArray(diagnosticOutputs) ||
    diagnosticOutputs.some(
      (entry, index) =>
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).some((key) => key !== 'task_node' && key !== 'paths') ||
        typeof entry.task_node !== 'string' ||
        entry.task_node.length === 0 ||
        (index > 0 &&
          compare(diagnosticOutputs[index - 1]?.task_node ?? '', entry.task_node) >= 0) ||
        !Array.isArray(entry.paths) ||
        entry.paths.length === 0 ||
        entry.paths.some(
          (path: unknown, pathIndex: number) =>
            typeof path !== 'string' ||
            !canonicalContainerPath(path) ||
            (pathIndex > 0 && compare(entry.paths[pathIndex - 1] ?? '', path) >= 0),
        ),
    )
  )
    throw new Error('release-certification-diagnostic-controls-invalid');
  const validatedDiagnosticOutputs: NonNullable<
    ContainerReleaseCertificationOptions['diagnostic_outputs']
  > = diagnosticOutputs;
  const diagnosticsByTask = new Map(
    validatedDiagnosticOutputs.map((entry) => [entry.task_node, entry.paths]),
  );
  if (
    !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms <= 0 ||
    toolchain.node !== controls.node_version ||
    [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PATH',
      'HOME',
      'TMPDIR',
      'DOCKER_HOST',
      'DOCKER_CONFIG',
    ].some((key) => Object.hasOwn(environment, key))
  ) {
    throw new Error('release-certification-container-controls-invalid');
  }
  const selected = plans.map((plan) => {
    if (!isVerifiedReleasePolicyResolution(plan.resolution))
      throw new Error('rpl-policy-resolution-mismatch');
    const verification = {
      repository_id: input.repository_id,
      intent_path: plan.intent_path,
      intent: plan.intent,
      release_verification_profile: plan.release_verification_profile,
      release_lifecycle_policy: plan.release_lifecycle_policy,
      action_registry: plan.action_registry,
      resolution: plan.resolution,
    };
    if (!verifyResolvedReleasePlanReceipt({ resolution: plan.resolution, receipt: plan.receipt }))
      throw new Error('release-certification-plan-binding-invalid');
    const receipt = buildReleasePlanReceipt(verification);
    if (receipt.verdict !== 'pass' || canonicalJson(receipt) !== canonicalJson(plan.receipt))
      throw new Error('release-certification-plan-binding-invalid');
    return { plan, receipt, intent: object(plan.intent), preflight: plan.preflight_receipt };
  });
  if (input.fixture_context !== undefined && input.toolchain_fixture !== undefined)
    throw new Error('release-toolchain-fixture-compatibility-invalid');
  const fixtureResolution = selected[0]?.plan.resolution;
  let fixtureContext = input.fixture_context;
  if (input.toolchain_fixture !== undefined) {
    if (selected.length !== 1 || fixtureResolution === undefined)
      throw new Error('release-toolchain-fixture-compatibility-invalid');
    fixtureContext = createProtectedToolchainFixtureContext({
      ...input.toolchain_fixture,
      fixture_resolution: fixtureResolution,
      controls,
      dependencies: input.dependencies ?? [],
      environment,
      toolchain,
    });
  }
  const fixtureIdentity =
    fixtureContext === undefined
      ? undefined
      : bindProtectedToolchainFixtureContext(fixtureContext, {
          container: container.identity,
          environment,
          toolchain,
          resolutions: selected.map(({ plan }) => plan.resolution),
          receipts: selected.map(({ receipt }) => ({
            receipt_id: receipt.receipt_id,
            receipt_digest_sha256: receipt.receipt_digest_sha256,
          })),
          diagnostic_outputs: diagnosticOutputs,
        });
  const bindingIdentity = {
    container: container.identity,
    candidate_git_metadata: 'verified-candidate-shallow-v1',
    toolchain,
    environment,
    ...(diagnosticOutputs.length === 0 ? {} : { diagnostic_outputs: diagnosticOutputs }),
    ...(fixtureIdentity === undefined ? {} : { fixture_input_identity: fixtureIdentity }),
    plans: selected.map(({ plan, receipt }) => ({
      receipt_id: receipt.receipt_id,
      receipt_digest_sha256: receipt.receipt_digest_sha256,
      packages: plan.packages,
    })),
  };
  const runtimeIdentity: Json = snapshot(
    Object.fromEntries(
      RUNTIME_IDENTITY_KEYS.filter((key) => Object.hasOwn(container.identity, key)).map((key) => [
        key,
        container.identity[key],
      ]),
    ),
  );
  return {
    selected,
    root,
    toolchain,
    environment,
    bindingIdentity,
    controls,
    fixtureContext,
    container,
    diagnosticsByTask,
    runtimeIdentity,
    fixtureIdentity,
    diagnosticOutputs,
    validatedDiagnosticOutputs,
  };
}
