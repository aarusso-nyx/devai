import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { withProtectedReleaseRepositoryContext } from '@devai-nyx/authority';
import { assertCliInvocationIdle, invokeDevaiCli } from '../cli-runtime.js';
import { installReleaseLifecycleCommandAdapters } from '../commands/release/lifecycle.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';

import { createResolvedReleasePlanInputResolver } from './release-policy-resolution.js';
import { createReleasePolicyClosure } from './release-policy-closure.js';
import { encodeReleasePolicyClosure } from './release-policy-closure-transport.js';
import { createReleaseExportProvider } from './release-export-provider.js';

import {
  createContainerReleaseCertificationAdapters,
  createContainerReleasePreflightProvider,
} from './release-certification-provider.js';

import { createReleaseCertificationEvidenceStore } from './release-evidence-store.js';
import { createReleaseArtifactStore } from './release-artifact-store.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  type ImmutableReleaseContentSource,
} from './release-prepare-kernel.js';
import {
  validateReleaseLifecycleRequest,
  type ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';
import type {
  ProtectedReleaseHostRunnerControls,
  ProtectedReleaseHostRunner,
  ProtectedReleaseHostInvocation,
} from './release-protected-host-runner-types.js';
import {
  fail,
  closed,
  captureReleaseHostLane,
  same,
  copy,
  INPUT_INVALID,
  regularInput,
} from './release-protected-host-runner-lane.js';
import {
  assertProtectedHostRunnerControls,
  captureProtectedLaterStages,
} from './release-protected-host-runner-stages.js';
export type {
  ProtectedReleaseInputFile,
  ProtectedReleaseHostLaneControls,
  ProtectedReleaseHostRunnerControls,
  ProtectedReleaseHostExportControls,
  ProtectedReleaseHostOfflineControls,
  ProtectedReleaseHostEvidencePublicationControls,
  ProtectedReleaseHostPublicationControls,
  ProtectedReleaseHostInvocation,
  ProtectedReleaseHostRunner,
} from './release-protected-host-runner-types.js';
let installed = false;

/**
 * Package-owned host composition, called once on the approved bootstrap runtime.
 * Controls and producer approval belong to the operator, never candidate code.
 * A campaign binds one production release unit and optionally its fixed diagnostic
 * preflight lane up front. Only production receives durable-store adapters; no
 * provider, compatibility brand or derived mutation plan escapes this runner.
 *
 * Existing CLI actions run sequentially against digest-pinned inputs and exact
 * prebound lane identities. No retry, next-action dispatch, adapter disposal,
 * cwd change or authority inference occurs. Export, offline verification and remote
 * publication each require their explicit protected controls; absent stages remain
 * unavailable. Input revalidation detects races but is not native openat containment
 * or protection against ABA.
 */
export function createProtectedReleaseHostRunner(
  input: ProtectedReleaseHostRunnerControls,
): ProtectedReleaseHostRunner {
  assertCliInvocationIdle();
  if (installed) fail('release-host-runner-already-installed');
  const laneFields = assertProtectedHostRunnerControls(input);
  assertBoundReleaseHostPackageSnapshot(input.installed_package);
  const { evidencePublication, publication, offlineProvider, offlineClosures, exportControls } =
    captureProtectedLaterStages(input);
  const cwd = process.cwd();
  const production = captureReleaseHostLane(input);
  const { root, repository, resolution, receipt, git, material } = production;
  let fixture: ReturnType<typeof captureReleaseHostLane> | undefined;
  if (Object.hasOwn(input, 'toolchain_fixture')) {
    closed(input.toolchain_fixture, laneFields);
    if (input.toolchain_fixture === undefined) return fail();
    fixture = captureReleaseHostLane({
      ...input.toolchain_fixture,
      installed_package: input.installed_package,
    });
    if (
      fixture.repository.id === repository.id ||
      fixture.root === root ||
      fixture.root.startsWith(`${root}${sep}`) ||
      root.startsWith(`${fixture.root}${sep}`) ||
      !same(fixture.execution.controls, production.execution.controls) ||
      !same(fixture.execution.environment, production.execution.environment) ||
      !same(fixture.execution.toolchain, production.execution.toolchain) ||
      Object.hasOwn(fixture.unit, 'preflight_receipt') ||
      Object.hasOwn(input.toolchain_fixture.unit, 'preflight_receipt')
    )
      fail();
  }
  const fixtureProvider =
    fixture === undefined
      ? undefined
      : createContainerReleasePreflightProvider({
          ...fixture.execution,
          repository_root: fixture.root,
          repository_id: fixture.repository.id,
          plans: [fixture.material],
          content_source: fixture.git,
          diagnostic_outputs: [
            {
              task_node: 'diagnostic:mutation-toolchain',
              paths: [
                'packages/fixture/reports/mutation/compatibility.json',
                'packages/fixture/reports/mutation/raw.json',
              ],
            },
          ],
          toolchain_fixture: {
            candidate: fixture.candidate,
            installed_package: input.installed_package,
            production_resolution: resolution,
          },
        });
  const verifySignature = input.publication_signature_verifier;
  const certificationOptions = copy(input.certification_store);
  const artifactOptions = copy(input.artifact_store);
  // repository_roots is the store's exclusion census, not a write allowlist.
  // Both candidates must be excluded so a production store cannot sit inside the fixture.
  if (
    !certificationOptions.repository_roots.includes(root) ||
    !artifactOptions.repository_roots.includes(root) ||
    (fixture !== undefined &&
      (!certificationOptions.repository_roots.includes(fixture.root) ||
        !artifactOptions.repository_roots.includes(fixture.root))) ||
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
  const certification = createContainerReleaseCertificationAdapters({
    ...production.execution,
    repository_root: root,
    repository_id: repository.id,
    plans: [material],
    content_source: git,
    evidence_sink: evidence,
  });
  const content: ImmutableReleaseContentSource = {
    ...git,
    unit_mutation_maximum_bytes: evidence.unit_mutation_maximum_bytes,
    readUnitMutationEvidenceClosure: (value) => evidence.readUnitMutationEvidenceClosure(value),
    readUnitMutationEvidenceReceipt: (value) => evidence.readUnitMutationEvidenceReceipt(value),
    readUnitMutationEvidenceBlob: (value) => evidence.readUnitMutationEvidenceBlob(value),
    readCertificationEvidenceReceipt: (value) => evidence.readCertificationEvidenceReceipt(value),
    readCertificationOutputClosure: (value) => evidence.readCertificationOutputClosure(value),
    readGeneratedBlob: (value) => evidence.readGeneratedBlob(value),
  };
  const exportDelivery =
    exportControls === 'unavailable'
      ? undefined
      : createReleaseExportProvider({
          provider: exportControls.provider,
          destination: exportControls.destination,
          trust: exportControls.trust,
          signer: exportControls.signer,
          mutation_source: content,
          // Committed certification custody only: no task, checkout or cache is reachable.
          certification_source: {
            ...(evidence.certified_evidence_carrier_maximum_bytes === undefined
              ? {}
              : {
                  certified_evidence_carrier_maximum_bytes:
                    evidence.certified_evidence_carrier_maximum_bytes,
                }),
            ...(evidence.readCertifiedEvidenceCarrier === undefined
              ? {}
              : {
                  readCertifiedEvidenceCarrier: (value) =>
                    evidence.readCertifiedEvidenceCarrier?.(value) ??
                    fail('release-certification-evidence-carrier-unavailable'),
                }),
          },
          plan: {
            resolve_plan_input: createResolvedReleasePlanInputResolver(resolution),
            resolve_receipt: (locator) => {
              if (
                locator.kind !== 'release-plan-receipt' ||
                locator.receipt_id !== receipt.receipt_id ||
                locator.receipt_digest_sha256 !== receipt.receipt_digest_sha256
              )
                fail(INPUT_INVALID);
              return copy(receipt);
            },
          },
          store: {
            ...artifactOptions,
            implementation: input.installed_package,
            parent_reader: artifacts,
            closure_limits: exportControls.closure_limits,
            transport_limits: exportControls.transport_limits,
            transcript_limits: exportControls.transcript_limits,
            closures: production.candidateLocator.release_units.flatMap((unit) =>
              unit.package_roster.map((pkg) => ({
                package_id: pkg.package_id,
                expected: production.expected,
                bytes: encodeReleasePolicyClosure(
                  createReleasePolicyClosure({ plan: receipt, resolution }),
                  exportControls.transport_limits,
                ),
              })),
            ),
          },
        });
  const exportLimits =
    exportControls === 'unavailable' ? undefined : copy(exportControls.transcript_limits);
  let pinnedRequest: ReleaseLifecycleRequest | undefined;
  let activeLane = production;
  const assertRequest = (request: ReleaseLifecycleRequest) => {
    if (pinnedRequest !== undefined && !same(request, pinnedRequest)) fail(INPUT_INVALID);
    if (
      !same(request.repository_locator, activeLane.repository) ||
      !same(request.candidate_locator, activeLane.candidateLocator) ||
      (activeLane === fixture && request.action_id !== 'release preflight')
    )
      fail(INPUT_INVALID);
    // Resume forbids receipt locators in its request; its separately pinned
    // receipt-document array below must contain this exact plan instead.
    // Evidence publication binds the independently verified offline receipt; its
    // plan is reconstructed from the pinned host policy, not a second request locator.
    if (request.action_id === 'release resume' || request.action_id === 'release evidence-publish')
      return;
    const plans =
      request.receipt_locators?.filter((value) => value.kind === 'release-plan-receipt') ?? [];
    if (
      plans.length !== 1 ||
      plans[0]?.receipt_id !== activeLane.receipt.receipt_id ||
      plans[0].receipt_digest_sha256 !== activeLane.receipt.receipt_digest_sha256
    )
      fail(INPUT_INVALID);
  };
  let active = false;
  const requireActive = () => {
    if (
      !active ||
      process.cwd() !== cwd ||
      realpathSync(root) !== root ||
      (fixture !== undefined && realpathSync(fixture.root) !== fixture.root)
    )
      fail('release-host-invocation-unbound');
  };
  const requireProduction = (request: ReleaseLifecycleRequest) => {
    requireActive();
    if (activeLane !== production) fail('release-host-stage-unavailable');
    assertRequest(request);
  };
  // Deliberately retain no disposer. One host process owns one immutable binding.
  installed = true;
  installReleaseLifecycleCommandAdapters({
    policy_resolution(value) {
      requireActive();
      if (
        value.repository_id !== activeLane.repository.id ||
        !same(value.candidate, {
          commit: activeLane.repository.commit,
          tree: activeLane.repository.tree,
        }) ||
        value.release_unit !== activeLane.resolution.release_unit
      )
        fail(INPUT_INVALID);
      return activeLane.resolution;
    },
    preflight_provider(request) {
      requireActive();
      assertRequest(request);
      return activeLane === fixture
        ? (fixtureProvider ?? fail())
        : certification.preflight_provider;
    },
    certification_provider(request) {
      requireProduction(request);
      return certification.certification_provider(request);
    },
    prepare_content_source(request) {
      requireProduction(request);
      return content;
    },
    artifact_sink(request) {
      requireProduction(request);
      return artifacts;
    },
    artifact_reader(request) {
      requireProduction(request);
      return exportDelivery?.reader ?? artifacts;
    },
    export_limits(request) {
      requireProduction(request);
      return exportLimits === undefined ? undefined : copy(exportLimits);
    },
    publication_signature_verifier(request) {
      requireProduction(request);
      return verifySignature;
    },
    provider(action, request) {
      requireProduction(request);
      return action === 'release export'
        ? exportDelivery?.provider
        : action === 'release evidence-publish'
          ? evidencePublication?.provider
          : action === 'release publish'
            ? publication?.provider
            : undefined;
    },
    offline_verification_provider(request) {
      requireProduction(request);
      return offlineProvider;
    },
    offline_policy_closures(request) {
      requireProduction(request);
      return offlineClosures?.(copy(request));
    },
    authorization(request) {
      requireProduction(request);
      return request.action_id === 'release evidence-publish'
        ? evidencePublication?.authorization(copy(request))
        : request.action_id === 'release publish'
          ? publication?.authorization(copy(request))
          : undefined;
    },
    offline_receipt_verifier(request) {
      requireProduction(request);
      return request.action_id === 'release evidence-publish'
        ? evidencePublication?.offline_receipt_verifier(copy(request))
        : undefined;
    },
    publication_controls(request) {
      requireProduction(request);
      return request.action_id === 'release publish'
        ? publication?.publication_controls(copy(request))
        : undefined;
    },
  });
  return Object.freeze({
    readPlan: () => copy(receipt),
    readPolicyClosure: () => createReleasePolicyClosure({ plan: receipt, resolution }),
    readCertificationTaskPolicies: (value: ReleaseLifecycleRequest) => {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      if (process.cwd() !== cwd || realpathSync(root) !== root)
        fail('release-host-working-directory-changed');
      const request = validateReleaseLifecycleRequest(copy(value), 'release certify');
      assertRequest(request);
      return copy(certification.read_task_policies(request));
    },
    readFixturePlan: () =>
      fixture === undefined ? fail('release-host-fixture-unavailable') : copy(fixture.receipt),
    readMutationInputPlan: () => {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      return fail('mutation-offloaded-to-bedel');
    },
    async invoke(value: ProtectedReleaseHostInvocation) {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      if (
        process.cwd() !== cwd ||
        realpathSync(root) !== root ||
        (fixture !== undefined && realpathSync(fixture.root) !== fixture.root)
      )
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
            ...(exportDelivery === undefined ? [] : ['release export']),
            'release resume',
            ...(offlineProvider === undefined ? [] : ['release offline-verify']),
            ...(evidencePublication === undefined ? [] : ['release evidence-publish']),
            ...(publication === undefined ? [] : ['release publish']),
          ].includes(action)
        )
          fail('release-host-stage-unavailable');
        closed(
          value,
          [
            'action',
            ...(['release plan', 'release resume', 'release offline-verify'].includes(action)
              ? []
              : ['as_role', 'write']),
            ...(action === 'release plan' ? ['intent'] : ['request']),
            ...(action === 'release resume' ? ['receipts'] : []),
            ...(['release evidence-publish', 'release publish'].includes(action)
              ? ['allow_publish']
              : []),
            ...(action === 'release offline-verify' ? ['exported_state'] : []),
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
        if ('allow_publish' in invocation && typeof invocation.allow_publish !== 'boolean') fail();
        let request: ReleaseLifecycleRequest | undefined;
        if (invocation.action !== 'release plan') {
          request = validateReleaseLifecycleRequest(
            regularInput(invocation.request, Math.max(production.maximum, fixture?.maximum ?? 0)),
            invocation.action,
          );
          activeLane = same(request.repository_locator, production.repository)
            ? production
            : fixture !== undefined && same(request.repository_locator, fixture.repository)
              ? fixture
              : fail(INPUT_INVALID);
          // Reapply the selected lane's input bound; the approved digest must still match.
          regularInput(invocation.request, activeLane.maximum);
          assertRequest(request);
          pinnedRequest = copy(request);
        }
        const args = [
          ...action.split(' '),
          ...('allow_publish' in invocation && invocation.allow_publish ? ['--allow-publish'] : []),
          '--repo-root',
          activeLane.root,
          ...('as_role' in invocation
            ? ['--as-role', invocation.as_role, ...(invocation.write ? ['--write'] : [])]
            : []),
        ];
        if (invocation.action === 'release plan') {
          if (!same(regularInput(invocation.intent, production.maximum), production.unit.intent))
            fail(INPUT_INVALID);
          args.push('--intent', invocation.intent.path, '--repository', repository.id);
        } else {
          args.push('--request', invocation.request.path);
          if (invocation.action === 'release offline-verify') {
            regularInput(invocation.exported_state, production.maximum);
            args.push('--exported-state', invocation.exported_state.path);
          } else {
            args.push('--state-root', activeLane.stateRoot);
          }
          if (invocation.action === 'release resume') {
            const receipts = regularInput(invocation.receipts, production.maximum);
            if (!Array.isArray(receipts) || !receipts.some((value) => same(value, receipt)))
              fail(INPUT_INVALID);
            args.push('--receipts', invocation.receipts.path);
            if (invocation.publication_receipt !== undefined) {
              regularInput(invocation.publication_receipt, production.maximum);
              args.push('--publication-receipt', invocation.publication_receipt.path);
            }
          }
        }
        const result = await (action === 'release plan' || action === 'release resume'
          ? invokeDevaiCli(args)
          : withProtectedReleaseRepositoryContext(activeLane.repositoryContext, () =>
              invokeDevaiCli(args),
            ));
        return result;
      } finally {
        pinnedRequest = undefined;
        activeLane = production;
        active = false;
      }
    },
  });
}
