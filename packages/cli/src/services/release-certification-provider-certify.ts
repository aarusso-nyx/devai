import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { readProtectedCompletedTaskResults } from './check-runner/runner.js';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
} from './release-certified-evidence-carrier.js';
import type { CheckRunnerOptions } from './check-runner/types.js';
import { canonicalContainerPath } from './container-archive.js';
import type {
  CertificationPackageEntry,
  ReleaseLifecycleRequest,
  ReleaseProviderResult,
} from './release-lifecycle-execution.js';
import type {
  CertificationEvidenceTransaction,
  ProtectedCertificationProvider,
} from './release-lifecycle-certification.js';
import {
  finalizeCertificationManifest,
  type CertificationOutputClosure,
} from './release-prepare-kernel.js';
import {
  compare,
  digest,
  outputPaths,
  pendingMutationPrerequisites,
} from './release-certification-provider-state.js';
import type { ContainerReleaseScope } from './release-certification-provider-execution.js';
import { certificationPlanner } from './release-certification-provider-requests.js';

/**
 * Certify a bound request: run every planned unit in the container, finalize its evidence
 * through the supplied sink, and return the release material; one certification at a time.
 */
export async function certifyReleaseWithContainer(
  scope: Pick<
    ContainerReleaseScope,
    'activity' | 'bindRequest' | 'sourcesFor' | 'execute' | 'adapters' | 'selected' | 'material'
  > & {
    readonly request: ReleaseLifecycleRequest;
    readonly options: readonly CheckRunnerOptions[];
    readonly policies: ReturnType<ReturnType<typeof certificationPlanner>>['policies'];
  },
  call: Parameters<ProtectedCertificationProvider['certify']>[0],
): Promise<ReleaseProviderResult> {
  const {
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
  } = scope;
  if (activity.active) throw new Error('release-certification-provider-in-use');
  activity.active = true;
  try {
    bindRequest(call.request);
    if (canonicalJson(call.request) !== canonicalJson(request))
      throw new Error('release-certification-plan-binding-invalid');
    const source = await sourcesFor(request);
    const runs: Awaited<ReturnType<typeof execute>>[] = [];
    for (const option of options)
      runs.push(await execute(request, option, source.source, source.gitMetadata));
    if (
      runs.some(
        (run, index) =>
          run.report.plan.taskPolicyDigest !== policies[index]?.taskPolicyDigest ||
          canonicalJson(run.report.plan.taskPolicy) !==
            canonicalJson(call.task_policies[index]?.document),
      )
    )
      throw new Error('release-task-policy-identity-mismatch');
    if (runs.every((run) => run.mutation_prerequisites !== undefined))
      pendingMutationPrerequisites.set(adapters.certification_provider, {
        request_digest: canonicalSha256(request),
        closures: runs.map((run) => {
          if (run.mutation_prerequisites === undefined)
            throw new Error('release-certification-prerequisite-proof-invalid');
          return run.mutation_prerequisites;
        }),
      });
    const prepared = runs.flatMap((run, unitIndex) => {
      const unit = request.candidate_locator.release_units[unitIndex];
      const entry = selected[unitIndex];
      if (unit === undefined || entry === undefined)
        throw new Error('release-certification-plan-binding-invalid');
      const declared = outputPaths(run.report.plan);
      const executionOnly = new Set(
        run.report.plan.tasks.flatMap((task) =>
          task.outputContract.execution_only_paths === true
            ? [...outputPaths({ ...run.report.plan, tasks: [task] }).keys()]
            : [],
        ),
      );
      const mapped = new Set<string>();
      const packages = entry.plan.packages.map((pkg, pkgIndex) => {
        const requested = unit.package_roster[pkgIndex];
        if (requested === undefined || !requested.manifest_path.endsWith('package.json'))
          throw new Error('release-certification-plan-binding-invalid');
        const prefix = requested.manifest_path.slice(0, -'package.json'.length);
        const paths = [...pkg.source_entries, ...pkg.generated_entries.map((value) => value.path)];
        if (
          !pkg.source_entries.includes('package.json') ||
          paths.some((path) => !canonicalContainerPath(path)) ||
          new Set(paths).size !== paths.length
        )
          throw new Error('release-certification-output-closure-invalid');
        const projected = run.namespaces.filter(
          (namespace) =>
            namespace.package_manifest === requested.manifest_path &&
            namespace.package_id === pkg.package_id,
        );
        const generatedMapping = [
          ...pkg.generated_entries,
          ...projected.flatMap((namespace) =>
            [...run.outputs.keys()]
              .filter((path) => path.startsWith(`${namespace.prefix}/`))
              .map((path) => ({
                path: path.slice(prefix.length),
                task_node: namespace.task_node,
              })),
          ),
        ];
        const generated = generatedMapping
          .map((value) => {
            const path = `${prefix}${value.path}`;
            const output = run.outputs.get(path);
            if (
              output === undefined ||
              (declared.get(path) ?? run.producers.get(path)) !== value.task_node ||
              mapped.has(path) ||
              pkg.source_entries.includes(value.path)
            )
              throw new Error('release-certification-output-closure-invalid');
            mapped.add(path);
            return { ...output, path: value.path };
          })
          .sort((left, right) => compare(left.path, right.path));
        const sourceEntries: CertificationPackageEntry[] = pkg.source_entries.map((path) => {
          const locator = source.locators.get(`${prefix}${path}`);
          if (locator === undefined) throw new Error('release-prepare-git-locator-invalid');
          return {
            path,
            mode: locator.mode,
            sha256: locator.content_digest_sha256,
            size_bytes: locator.size_bytes,
            immutable_blob_locator: locator,
          };
        });
        return {
          unitIndex,
          pkgIndex,
          package_id: pkg.package_id,
          version: unit.version,
          sourceEntries,
          generated,
          binding: {
            repository: request.repository_locator,
            candidate: {
              commit: request.candidate_locator.commit,
              tree: request.candidate_locator.tree,
            },
            task_policy_digest_sha256: run.report.plan.taskPolicyDigest,
            package_id: pkg.package_id,
          },
        };
      });
      if (
        [...run.outputs.keys()].some(
          (path) =>
            !mapped.has(path) &&
            !executionOnly.has(path) &&
            !run.namespaces.some(
              (namespace) => namespace.execution_only && path.startsWith(`${namespace.prefix}/`),
            ),
        )
      )
        throw new Error('release-certification-output-closure-invalid');
      return packages;
    });
    const first = runs[0];
    if (first === undefined) throw new Error('release-certification-plan-binding-invalid');
    const sinkHost = createProtectedReleaseHostAdapter(first.binding);
    const transaction = await sinkHost.invokeSink(
      () => call.evidence_sink.begin(prepared.map((pkg) => pkg.binding)),
      call.evidence_sink.authority_owner,
    );
    let committing = false;
    let closures: readonly CertificationOutputClosure[];
    const drafts: Parameters<CertificationEvidenceTransaction['commit']>[0][number][] = [];
    try {
      for (const pkg of prepared) {
        const outputs = [];
        for (const output of pkg.generated) {
          const handle = await sinkHost.invokeSink(
            () =>
              transaction.put({
                bytes: Buffer.from(output.bytes),
                sha256: digest(output.bytes),
                size_bytes: output.bytes.length,
              }),
            call.evidence_sink.authority_owner,
          );
          if (
            handle.sha256 !== digest(output.bytes) ||
            handle.size_bytes !== output.bytes.length ||
            handle.evidence_sink_id !== transaction.evidence_sink_id
          )
            throw new Error('release-certification-output-closure-invalid');
          outputs.push({
            path: output.path,
            mode: output.mode,
            output_blob_handle: handle,
          });
        }
        drafts.push({ ...pkg.binding, outputs });
      }
      // Retain one complete carrier per release unit inside this same
      // transaction, from the live protected population, before commit.
      // Digest-only census: generated bytes and raw streams never enter it.
      const carrierMaximum = call.evidence_sink.certified_evidence_carrier_maximum_bytes;
      if (
        typeof transaction.putCertifiedEvidenceCarrier !== 'function' ||
        carrierMaximum === undefined ||
        !Number.isSafeInteger(carrierMaximum) ||
        carrierMaximum < 1
      )
        throw new Error('release-certification-evidence-carrier-unavailable');
      for (const [unitIndex, run] of runs.entries()) {
        const unit = request.candidate_locator.release_units[unitIndex];
        const receipt = run.report.receipt?.value;
        if (unit === undefined || receipt === undefined)
          throw new Error('release-certification-evidence-carrier-unavailable');
        const derivation = {
          repository: request.repository_locator,
          candidate: {
            commit: request.candidate_locator.commit,
            tree: request.candidate_locator.tree,
          },
          task_policy_digest_sha256: run.report.plan.taskPolicyDigest,
        };
        const census = finalizeCertifiedEvidenceNamespaceCensus({
          release_unit: unit.release_unit,
          derivation,
          entries: [...run.outputs.values()].map((output) => {
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
        });
        const bytes = createCertifiedEvidenceCarrier({
          release_unit: unit.release_unit,
          derivation,
          candidate_receipt: receipt,
          task_policy: run.report.plan.taskPolicy,
          task_results: readProtectedCompletedTaskResults(run.report),
          namespace_census: census,
          maximum_bytes: carrierMaximum,
        });
        const identity = await sinkHost.invokeSink(
          () =>
            transaction.putCertifiedEvidenceCarrier?.({
              release_unit: unit.release_unit,
              bytes,
              sha256: digest(bytes),
              size_bytes: bytes.length,
            }),
          call.evidence_sink.authority_owner,
        );
        if (
          identity === undefined ||
          identity.release_unit !== unit.release_unit ||
          identity.sha256 !== digest(bytes) ||
          identity.size_bytes !== bytes.length ||
          identity.evidence_sink_id !== transaction.evidence_sink_id
        )
          throw new Error('release-certification-evidence-carrier-unavailable');
      }
      committing = true;
      closures = await sinkHost.invokeSink(
        () => transaction.commit(drafts),
        call.evidence_sink.authority_owner,
      );
      if (
        canonicalJson(
          closures.map((closure) => ({
            ...closure,
            outputs: closure.outputs.map(
              ({ certification_evidence_receipt: _receipt, ...output }) => output,
            ),
          })),
        ) !== canonicalJson(drafts)
      )
        throw new Error('release-certification-output-closure-invalid');
    } catch (error) {
      if (!committing)
        await sinkHost.invokeSink(() => transaction.abort(), call.evidence_sink.authority_owner);
      throw error;
    }
    const result = material(
      request,
      runs.map((run) => run.report),
      source.locators,
    );
    const release_units = result.release_units.map((unit, unitIndex) => ({
      ...unit,
      packages: unit.packages.map((pkg, pkgIndex) => {
        const draft = prepared.find(
          (entry) => entry.unitIndex === unitIndex && entry.pkgIndex === pkgIndex,
        );
        const closure = closures.find(
          ({ outputs: _outputs, ...binding }) =>
            draft !== undefined && canonicalJson(binding) === canonicalJson(draft.binding),
        );
        if (draft === undefined || closure === undefined)
          throw new Error('release-certification-output-closure-invalid');
        const generated: CertificationPackageEntry[] = closure.outputs.map((output) => ({
          path: output.path,
          mode: output.mode,
          sha256: output.output_blob_handle.sha256,
          size_bytes: output.output_blob_handle.size_bytes,
          immutable_blob_locator: {
            kind: 'generated-output',
            output_blob_sha256: output.output_blob_handle.sha256,
            output_blob_handle: output.output_blob_handle,
            certification_evidence_receipt: output.certification_evidence_receipt,
          },
        }));
        return {
          ...pkg,
          certification_manifest: finalizeCertificationManifest({
            candidate: draft.binding.candidate,
            task_policy_digest_sha256: draft.binding.task_policy_digest_sha256,
            package_id: draft.package_id,
            package_version: draft.version,
            entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
            manifest_digest_contract: {
              domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
              payload:
                'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
              canonicalization: 'rfc8785-jcs',
              algorithm: 'sha256',
            },
            entries: [...draft.sourceEntries, ...generated].sort((left, right) =>
              compare(left.path, right.path),
            ),
          }),
        };
      }),
    }));
    return { outcome: 'success', material: { ...result, release_units } };
  } finally {
    activity.active = false;
  }
}
