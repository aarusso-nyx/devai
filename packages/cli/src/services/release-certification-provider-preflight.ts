import { canonicalSha256 } from '@devai-nyx/utils';
import { runCheckTasks } from './check-runner/runner.js';
import { canonicalContainerPath } from './container-archive.js';
import {
  attachProtectedToolchainFixtureCustody,
  issueProtectedToolchainFixtureCompatibility,
  observeProtectedToolchainFixtureInputs,
} from './release-toolchain-fixture-compatibility.js';
import type { ReleaseProvider } from './release-lifecycle-execution.js';
import {
  compare,
  digest,
  fixtureDiagnosticCustodies,
  fixtureProviderCompatibility,
  object,
  outputPaths,
  preflightObservations,
  snapshot,
  takeProtectedFixtureDiagnosticCustody,
  verifiedFixtureDiagnosticCustodies,
  verifiedPreflightObservations,
  type CapturedDiagnosticRun,
  type ProtectedFixtureDiagnosticCustody,
  type ProtectedPreflightObservation,
} from './release-certification-provider-state.js';
import type { ContainerReleaseScope } from './release-certification-provider-execution.js';

/** The diagnostic preflight provider over the same plans, container and bindings. */
export function releasePreflightProvider(
  scope: Pick<
    ContainerReleaseScope,
    | 'activity'
    | 'bindingIdentity'
    | 'runtimeIdentity'
    | 'fixtureIdentity'
    | 'fixtureContext'
    | 'bindRequest'
    | 'sourcesFor'
    | 'selected'
    | 'optionsFor'
    | 'diagnosticOutputs'
    | 'validatedDiagnosticOutputs'
    | 'execute'
    | 'material'
    | 'input'
  >,
): ReleaseProvider {
  const {
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
  } = scope;
  const preflight_provider: ReleaseProvider = async (request) => {
    if (activity.active)
      return { outcome: 'failure', code: 'release-certification-provider-in-use' };
    activity.active = true;
    fixtureProviderCompatibility.delete(preflight_provider);
    preflightObservations.delete(preflight_provider);
    fixtureDiagnosticCustodies.delete(preflight_provider);
    const diagnosticRuns: CapturedDiagnosticRun[] = [];
    const retainDiagnostics = (outcome: 'success' | 'failure'): void => {
      if (diagnosticRuns.length === 0) return;
      const bytesByRun = diagnosticRuns.map(
        (run) =>
          new Map(run.outputs.map((output) => [output.path, Buffer.from(output.bytes)] as const)),
      );
      const captured: ReturnType<ProtectedFixtureDiagnosticCustody['read']> = snapshot({
        request,
        execution_identity: bindingIdentity,
        runtime_identity: runtimeIdentity,
        ...(fixtureIdentity === undefined ? {} : { fixture_input_identity: fixtureIdentity }),
        outcome,
        runs: diagnosticRuns.map((run) => ({
          binding: run.binding,
          task_node: run.task_node,
          process: run.process,
          output_census: run.outputs
            .map((output) => ({
              path: output.path,
              mode: output.mode,
              sha256: digest(output.bytes),
              size_bytes: output.bytes.length,
              task_node: run.task_node,
            }))
            .sort((a, b) => compare(a.path, b.path)),
        })),
      });
      const custody: ProtectedFixtureDiagnosticCustody = Object.freeze({
        read: () => snapshot(captured),
        readOutput: (member: {
          readonly run_index: number;
          readonly path: string;
          readonly sha256: string;
        }): Buffer => {
          if (
            member === null ||
            typeof member !== 'object' ||
            !Number.isSafeInteger(member.run_index) ||
            member.run_index < 0 ||
            typeof member.path !== 'string' ||
            !canonicalContainerPath(member.path)
          )
            throw new Error('release-certification-diagnostic-output-unavailable');
          const expected = captured.runs[member.run_index]?.output_census.find(
            (output) => output.path === member.path,
          );
          const bytes = bytesByRun[member.run_index]?.get(member.path);
          if (expected === undefined || expected.sha256 !== member.sha256 || bytes === undefined)
            throw new Error('release-certification-diagnostic-output-unavailable');
          return Buffer.from(bytes);
        },
      });
      verifiedFixtureDiagnosticCustodies.add(custody);
      if (fixtureContext !== undefined && outcome === 'success')
        attachProtectedToolchainFixtureCustody(fixtureContext, custody);
      fixtureDiagnosticCustodies.set(preflight_provider, {
        request_digest: canonicalSha256(request),
        custody,
      });
    };
    try {
      if (request.action_id !== 'release preflight')
        throw new Error('release-certification-plan-binding-invalid');
      const descriptor = bindRequest(request);
      const source = await sourcesFor(request);
      const options = selected.map((_entry, index) =>
        optionsFor(request, descriptor, index, 'preflight'),
      );
      if (diagnosticOutputs.length !== 0) {
        const tasks = options.flatMap((option) => runCheckTasks(option).plan.tasks);
        for (const diagnostic of validatedDiagnosticOutputs) {
          const matched = tasks.filter((task) => task.nodeId === diagnostic.task_node);
          if (
            matched.length === 0 ||
            matched.some((task) => {
              const paths = outputPaths({ tasks: [task] });
              return diagnostic.paths.some((path) => !paths.has(path));
            })
          )
            throw new Error('release-certification-diagnostic-controls-invalid');
        }
      }
      if (fixtureContext !== undefined)
        observeProtectedToolchainFixtureInputs(fixtureContext, {
          request,
          source: source.source,
          descriptor,
          tasks: options.flatMap((option) => runCheckTasks(option).plan.tasks),
        });
      const runs: Awaited<ReturnType<typeof execute>>[] = [];
      for (const option of options)
        runs.push(
          await execute(request, option, source.source, source.gitMetadata, diagnosticRuns),
        );
      const reports = runs.map((run) => run.report);
      for (const [index, report] of reports.entries()) {
        if (report.preflightReceipt === undefined)
          throw new Error('release-certification-preflight-required');
        const entry = selected[index];
        if (entry !== undefined) entry.preflight = snapshot(report.preflightReceipt.value);
      }
      const stateMaterial = material(request, reports, source.locators);
      const captured: ReturnType<ProtectedPreflightObservation['read']> = snapshot({
        request,
        execution_identity: bindingIdentity,
        runs: runs.map((run) => ({
          binding: run.binding,
          preflight_receipt: object(run.report.preflightReceipt?.value),
          output_census: [...run.outputs.values()]
            .sort((a, b) => compare(a.path, b.path))
            .map((output) => {
              const producer = run.producers.get(output.path);
              if (producer === undefined)
                throw new Error('release-certification-output-closure-invalid');
              return {
                path: output.path,
                mode: output.mode,
                sha256: digest(output.bytes),
                size_bytes: output.bytes.length,
                task_node: producer,
              };
            }),
        })),
      });
      // Keep only identities after verified execution/quiescence. This does not retain
      // raw reports, certify their semantics, or discharge any production mutation gate.
      const observation: ProtectedPreflightObservation = Object.freeze({
        read: () => snapshot(captured),
      });
      verifiedPreflightObservations.add(observation);
      preflightObservations.set(preflight_provider, {
        request_digest: canonicalSha256(request),
        observation,
      });
      retainDiagnostics('success');
      if (input.toolchain_fixture !== undefined)
        fixtureProviderCompatibility.set(
          preflight_provider,
          issueProtectedToolchainFixtureCompatibility(
            takeProtectedFixtureDiagnosticCustody(preflight_provider, request),
          ),
        );
      return { outcome: 'success', material: stateMaterial };
    } catch (error) {
      fixtureProviderCompatibility.delete(preflight_provider);
      preflightObservations.delete(preflight_provider);
      try {
        retainDiagnostics('failure');
      } catch {
        // Invalid/consumed fixture context must not replace the original terminal
        // failure with a rejected promise or expose a partially attached custody.
        fixtureDiagnosticCustodies.delete(preflight_provider);
      }
      return {
        outcome: 'failure',
        // Native/tool diagnostics are not ledger codes and can expose host paths.
        // Keep the original failure terminal instead of making its record fail
        // schema validation and leaving only an ambiguous attempt behind.
        code:
          error instanceof Error && /^release-[a-z0-9-]+$/u.test(error.message)
            ? error.message
            : 'release-certification-task-failed',
      };
    } finally {
      activity.active = false;
    }
  };
  return preflight_provider;
}
