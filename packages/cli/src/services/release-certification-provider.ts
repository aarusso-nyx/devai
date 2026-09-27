import type { ReleaseProvider } from './release-lifecycle-execution.js';
import {
  pendingMutationPrerequisites,
  protectedPreflightProviders,
  type ContainerReleaseCertificationAdapters,
  type ContainerReleaseCertificationOptions,
} from './release-certification-provider-state.js';
import {
  captureContainerReleaseInputs,
  type ContainerReleaseAdapterInput,
} from './release-certification-provider-inputs.js';
import {
  containerTaskExecutor,
  releaseStateMaterializer,
} from './release-certification-provider-execution.js';
import {
  certificationPlanner,
  releaseRequestBinder,
  releaseSourceReader,
  releaseTaskOptions,
} from './release-certification-provider-requests.js';
import { releasePreflightProvider } from './release-certification-provider-preflight.js';
import { certifyReleaseWithContainer } from './release-certification-provider-certify.js';

export {
  assertProtectedFixtureProviderCompatibility,
  captureProtectedMutationPrerequisites,
  isProtectedReleasePreflightProvider,
  isVerifiedProtectedFixtureDiagnosticCustody,
  isVerifiedProtectedPreflightObservation,
  takeProtectedFixtureDiagnosticCustody,
  takeProtectedMutationPrerequisites,
  takeProtectedPreflightObservation,
} from './release-certification-provider-state.js';
export type {
  CapturedMutationPrerequisiteClosure,
  ContainerReleaseCertificationAdapters,
  ContainerReleaseCertificationOptions,
  ProtectedFixtureDiagnosticCustody,
  ProtectedMutationPrerequisiteBinding,
  ProtectedMutationPrerequisiteClosure,
  ProtectedPreflightObservation,
  ProtectedReleasePlanMaterial,
} from './release-certification-provider-state.js';

/**
 * Trusted installed-host composition. No candidate path, document, environment variable or CLI
 * argument can select this implementation, its engine/image, dependency bytes, sink or controls.
 * Each invocation uses a fresh check cache and fresh task namespaces. Preflight and certify use
 * identical container/toolchain identities; certify requires the genuine matching preflight.
 */
export function createContainerReleaseCertificationAdapters(
  input: ContainerReleaseCertificationOptions,
): ContainerReleaseCertificationAdapters {
  return createContainerReleaseAdapters(input);
}

/** Private diagnostic lane: no evidence store is accepted and no certify surface escapes. */
export function createContainerReleasePreflightProvider(
  input: Omit<ContainerReleaseCertificationOptions, 'evidence_sink'>,
): ReleaseProvider {
  if ('evidence_sink' in input)
    throw new Error('release-certification-diagnostic-controls-invalid');
  return createContainerReleaseAdapters(input).preflight_provider;
}

function createContainerReleaseAdapters(
  input: ContainerReleaseAdapterInput,
): ContainerReleaseCertificationAdapters {
  const {
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
  } = captureContainerReleaseInputs(input);
  const activity = { active: false };

  const bindRequest = releaseRequestBinder({ input, selected, root });
  const optionsFor = releaseTaskOptions({
    selected,
    root,
    toolchain,
    environment,
    input,
    bindingIdentity,
    controls,
  });
  const sourcesFor = releaseSourceReader({ root, input, controls });
  const execute = containerTaskExecutor({
    selected,
    fixtureContext,
    container,
    environment,
    root,
    diagnosticsByTask,
    toolchain,
  });
  const material = releaseStateMaterializer({ selected });
  const preflight_provider: ReleaseProvider = releasePreflightProvider({
    activity,
    bindingIdentity,
    runtimeIdentity,
    fixtureIdentity,
    fixtureContext,
    bindRequest,
    sourcesFor,
    selected,
    optionsFor,
    diagnosticOutputs,
    validatedDiagnosticOutputs,
    execute,
    material,
    input,
  });

  const planCertification = certificationPlanner({ bindRequest, selected, optionsFor });

  protectedPreflightProviders.add(preflight_provider);
  const adapters: ContainerReleaseCertificationAdapters = {
    preflight_provider,
    read_task_policies(request) {
      if (activity.active) throw new Error('release-certification-provider-in-use');
      return structuredClone(planCertification(request).task_policies);
    },
    certification_provider(request) {
      pendingMutationPrerequisites.delete(adapters.certification_provider);
      if (input.evidence_sink === undefined)
        throw new Error('release-certification-evidence-sink-unavailable');
      bindRequest(request);
      const { options, policies, task_policies } = planCertification(request);
      return {
        content_source: input.content_source,
        evidence_sink: input.evidence_sink,
        task_policies,
        provider: {
          kind: 'protected-certification-provider-v3',
          async certify(call) {
            return certifyReleaseWithContainer(
              {
                activity,
                bindRequest,
                sourcesFor,
                execute,
                adapters,
                selected,
                material,
                request,
                options,
                policies,
              },
              call,
            );
          },
        },
      };
    },
  };
  return adapters;
}
