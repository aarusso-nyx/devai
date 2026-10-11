import { assertCandidateSupersessionGraph, filterLatestPerKind } from '@devai-nyx/loop';
import { inspectNativeTestResults, type NativeTestResultContract } from './native-test-results.js';
import { readdirSync } from 'node:fs';
import { getValidator } from '@devai-nyx/schemas';
import { verifyLoadedChain, type EvidenceChain } from '@devai-nyx/evidence';
import {
  loadCandidateAuditProjection,
  computeHarnessInvariantAlignment,
  buildSensorReading,
  type HarnessInvariantAlignmentOptions,
  readCandidateFile,
  type DeclaredInvariantProducerStanding,
  type SensorReading,
} from '@devai-nyx/sensors';
import { sha256Hex, canonicalize } from '../../services/check-runner/canonical.js';
import {
  inspectNativeConfigurationSelection,
  inspectNativeInputProvenance,
} from './native-input-provenance.js';
import { resolveSensorTaskBinding } from './task-binding.js';

/** Resolve current task policy and independently bind actual stored execution to its chain receipt. */
export function declaredInvariantProducerStanding(
  root: string,
): readonly DeclaredInvariantProducerStanding[] {
  const projection = loadCandidateAuditProjection(root, 'invariant_producers');
  if (projection === undefined) return [];
  const rows = projection['bindings'] as {
    invariant_id: string;
    subject: string;
    taskId: string;
    population: string;
    requiredTestIds: string[];
  }[];
  if (rows.length === 0) return [];
  const descriptorBytes = readCandidateFile(root, 'test-tasks.json');
  const descriptor = JSON.parse(descriptorBytes.toString('utf8')) as {
    tasks: {
      nodeId: string;
      sensorKinds?: string[];
      outputContract: Record<string, unknown>;
      argv: string[];
      cwd: string;
    }[];
  };
  if (!getValidator('test-task-descriptor.schema.json')(descriptor))
    throw new Error('INVARIANT_PRODUCER_DESCRIPTOR_INVALID');
  const known = new Set(
    readdirSync(`${root}/law/invariants`)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const invariant = JSON.parse(
          readCandidateFile(root, `law/invariants/${file}`).toString('utf8'),
        ) as { id?: string };
        return invariant.id;
      }),
  );
  const pairs = new Set<string>();
  let chain: EvidenceChain = { head: null, records: [] };
  try {
    chain = JSON.parse(
      readCandidateFile(root, 'record/proofs/chain.json').toString('utf8'),
    ) as EvidenceChain;
    if (!verifyLoadedChain(chain).valid) throw new Error('INVARIANT_PRODUCER_CHAIN_INVALID');
  } catch {
    throw new Error('INVARIANT_PRODUCER_CHAIN_INVALID');
  }
  return rows.map((row): DeclaredInvariantProducerStanding => {
    const pair = canonicalize([row.invariant_id, row.subject]);
    if (pairs.has(pair) || !known.has(row.invariant_id))
      throw new Error('INVARIANT_PRODUCER_OBLIGATION_INVALID');
    pairs.add(pair);
    const node = descriptor.tasks.find((task) => task.nodeId === row.taskId);
    const kinds =
      node?.sensorKinds
        ?.filter((kind) => ['unit_test', 'integration_test', 'e2e_test'].includes(kind))
        .sort() ?? [];
    const kind = kinds[0];
    if (
      kind === undefined ||
      node === undefined ||
      node.outputContract['population'] !== row.population
    )
      throw new Error('INVARIANT_PRODUCER_TASK_MISMATCH');
    const contract = node.outputContract['resultPopulation'] as
      NativeTestResultContract | undefined;
    if (
      contract === undefined ||
      !row.requiredTestIds.every((id) => contract.requiredTestIds?.includes(id))
    )
      throw new Error('INVARIANT_PRODUCER_RESULT_IDS_MISMATCH');
    let binding: ReturnType<typeof resolveSensorTaskBinding>;
    try {
      binding = resolveSensorTaskBinding(root, kind, {
        taskId: row.taskId,
        population: row.population,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'SENSE_NATIVE_CANDIDATE_DIRTY')
        throw error;
      return {
        invariant_id: row.invariant_id,
        subject: row.subject,
        taskId: row.taskId,
        population: row.population,
        argv: node.argv,
        cwd: node.cwd,
        passed: false,
      };
    }
    if (binding === undefined) throw new Error('INVARIANT_PRODUCER_TASK_MISSING');
    const candidates = new Map<string, { reading: SensorReading; receiptTime: string }>();
    for (const [index, receipt] of chain.records.entries()) {
      if (
        receipt.action !== 'sense.readings.record' ||
        receipt.status !== 'completed' ||
        receipt.context.git.head_sha !== binding.plan.repository.commit
      )
        continue;
      for (const artifact of receipt.artifacts) {
        if (
          !kinds.some((member) =>
            artifact.path.startsWith(`.devai/state/sensor-readings/${member}/`),
          ) ||
          !artifact.path.endsWith('.json')
        )
          continue;
        const bytes = readCandidateFile(root, artifact.path);
        if (sha256Hex(bytes) !== artifact.sha256) continue;
        const origin = chain.records
          .slice(0, index)
          .find(
            (entry) =>
              entry.action === 'sense.task.execute' &&
              entry.status === 'completed' &&
              entry.context.git.head_sha === binding.plan.repository.commit &&
              entry.artifacts.some(
                (source) => source.path === artifact.path && source.sha256 === artifact.sha256,
              ),
          );
        if (
          origin === undefined ||
          Date.parse(receipt.timestamp) < Date.parse(origin.timestamp) ||
          Date.parse(receipt.timestamp) > Date.now()
        )
          continue;
        const reading = JSON.parse(bytes.toString('utf8')) as SensorReading;
        if (
          !getValidator('sensor-reading.schema.json')(reading) ||
          !kinds.includes(reading.sensor.kind) ||
          reading.metrics?.['task_id'] !== row.taskId ||
          reading.metrics['population'] !== row.population
        )
          continue;
        // Re-recording does not refresh an immutable instance's original standing.
        if (!candidates.has(reading.id))
          candidates.set(reading.id, { reading, receiptTime: origin.timestamp });
      }
    }
    const instances = [...candidates.values()].map((entry) => entry.reading);
    assertCandidateSupersessionGraph(instances, 'INVARIANT_PRODUCER');
    const terminal = filterLatestPerKind(instances);
    const passed =
      terminal.length > 0 &&
      terminal.every((reading) => {
        const selected = candidates.get(reading.id);
        if (selected === undefined) return false;
        const metrics = reading.metrics ?? {};
        const at = Date.parse(selected.receiptTime);
        const readingAt = Date.parse(reading.timestamp);
        const now = Date.now();
        const stdout = metrics['native_stdout'];
        const stderr = metrics['native_stderr'];
        const nonce = metrics['native_collection_nonce'];
        if (
          typeof stdout !== 'string' ||
          typeof stderr !== 'string' ||
          typeof nonce !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(nonce) ||
          metrics['native_selection_digest'] !== binding.nativeSelectionDigest ||
          typeof metrics['native_input_trace'] !== 'string' ||
          sha256Hex(Buffer.from(metrics['native_input_trace'])) !==
            metrics['native_input_trace_sha256'] ||
          inspectNativeInputProvenance(
            root,
            nonce,
            metrics['native_input_trace'],
            stdout,
            binding.task,
          ).length > 0 ||
          inspectNativeConfigurationSelection(root, stdout).length > 0 ||
          sha256Hex(Buffer.from(stdout)) !== metrics['stdout_sha256'] ||
          sha256Hex(Buffer.from(stderr)) !== metrics['stderr_sha256']
        )
          return false;
        const native = inspectNativeTestResults(contract, stdout, stderr, {
          repoRoot: binding.root,
          collectionNonce: nonce,
        });
        return (
          reading.status === 'pass' &&
          reading.exit_code === 0 &&
          reading.lifecycle !== 'experimental' &&
          Number.isFinite(at) &&
          Number.isFinite(readingAt) &&
          at <= now &&
          readingAt <= at &&
          now - at <= 86_400_000 &&
          now - readingAt <= 86_400_000 &&
          metrics['candidate_commit'] === binding.plan.repository.commit &&
          metrics['candidate_tree'] === binding.plan.repository.tree &&
          metrics['task_key'] === binding.task.taskKey &&
          metrics['input_digest'] === binding.task.inputDigest &&
          metrics['descriptor_digest'] === binding.plan.descriptorDigest &&
          metrics['task_policy_digest'] === binding.plan.taskPolicyDigest &&
          metrics['runner'] === binding.runner &&
          metrics['prerequisite_digests'] === canonicalize(binding.prerequisiteDigests) &&
          metrics['native_result_contract_sha256'] === sha256Hex(contract) &&
          canonicalize(native) === metrics['native_result_population'] &&
          native.status === 'pass' &&
          native.nativePlanSha256 === metrics['native_plan_sha256'] &&
          native.projectId === contract.projectId &&
          native.projectId === metrics['native_result_project'] &&
          canonicalize([...native.executedTestIds].sort()) ===
            canonicalize([...contract.requiredTestIds].sort()) &&
          canonicalize(native.executableFiles) === canonicalize(contract.executableFiles) &&
          row.requiredTestIds.every((id) => native.executedTestIds.includes(id))
        );
      });

    return {
      invariant_id: row.invariant_id,
      subject: row.subject,
      taskId: row.taskId,
      population: row.population,
      argv: binding.task.argv,
      cwd: binding.task.cwd,
      passed,
    };
  });
}

/** Private CLI adapter: all producer standing is derived here, never supplied by sensor input. */
export function senseDeclaredHarnessInvariantAlignment(
  opts: HarnessInvariantAlignmentOptions,
): SensorReading {
  const standing = declaredInvariantProducerStanding(opts.repoRoot);
  const facts = computeHarnessInvariantAlignment(opts, standing);
  return buildSensorReading({
    sensorName: 'harness-invariant-alignment',
    sensorKind: 'harness_invariant_alignment',
    command: ['devai', 'sense', 'run', 'harness_invariant_alignment'],
    deterministic: true,
    tier: 'L0',
    ...(opts.now === undefined ? {} : { timestamp: opts.now }),
    ...facts,
  });
}
