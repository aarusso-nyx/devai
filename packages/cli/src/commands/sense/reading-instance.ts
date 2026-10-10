import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertCandidateSupersessionGraph,
  gatherGitContext,
  loadChain,
  verifyLoadedChain,
} from '#runtime-core';
import { validators } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { canonicalJson } from '@devai-nyx/utils';

const STORE = '.devai/state/sensor-readings';

function measurement(reading: SensorReading): string {
  const { id: _id, supersedes: _supersedes, ...body } = reading;
  return canonicalJson(body);
}

/** Read-only producer instance selection; recording remains a separate Inspector action. */
export function resolveSensorReadingInstance(
  repoRoot: string,
  reading: SensorReading,
): SensorReading {
  const directory = join(repoRoot, STORE, reading.sensor.kind);
  if (!existsSync(directory)) {
    if (reading.supersedes !== undefined)
      throw new Error(`SENSE_INSTANCE_INVALID_SUPERSEDES:${reading.id}`);
    return reading;
  }
  const chainPath = join(repoRoot, 'record/proofs/chain.json');
  const chain = existsSync(chainPath) ? loadChain(chainPath) : { head: null, records: [] };
  if (!verifyLoadedChain(chain).valid) throw new Error('SENSE_INSTANCE_CHAIN_INVALID');
  const records = chain.records;
  const head = gatherGitContext(repoRoot).head_sha;
  const candidates: SensorReading[] = [];
  const stored = new Map<string, SensorReading>();
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith('.json')) continue;
    const bytes = readFileSync(join(directory, filename));
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!validators.sensorReading(parsed)) throw new Error('SENSE_INSTANCE_INVALID_READING');
    const prior = parsed as SensorReading;
    if (prior.sensor.kind !== reading.sensor.kind || filename !== `${prior.id}.json`) {
      throw new Error('SENSE_INSTANCE_STORE_IDENTITY_MISMATCH');
    }
    stored.set(prior.id, prior);
    const path = `${STORE}/${reading.sensor.kind}/${filename}`;
    const bindings = records.flatMap((entry) =>
      entry.action !== 'sense.readings.record'
        ? []
        : (entry.artifacts ?? [])
            .filter((artifact) => artifact.path === path)
            .map((artifact) => ({ sha256: artifact.sha256, head: entry.context?.git?.head_sha })),
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bindings.length > 0 && !bindings.some((binding) => binding.sha256 === digest)) {
      throw new Error(`SENSE_INSTANCE_CHAIN_DIGEST_MISMATCH:${prior.id}`);
    }
    if (
      head !== null &&
      bindings.some((binding) => binding.sha256 === digest && binding.head === head)
    ) {
      candidates.push(prior);
    }
  }
  assertCandidateSupersessionGraph(candidates, 'SENSE_INSTANCE');
  const retired = new Set(candidates.map((prior) => prior.supersedes));
  const current = candidates.filter((prior) => !retired.has(prior.id));
  if (candidates.length > 0 && current.length !== 1) {
    throw new Error(`SENSE_INSTANCE_AMBIGUOUS:${reading.sensor.kind}`);
  }
  const prior = current[0];
  if (prior !== undefined && measurement(prior) === measurement(reading)) return prior;
  const collision = stored.get(reading.id);
  if (prior === undefined && collision === undefined) {
    if (reading.supersedes !== undefined)
      throw new Error(`SENSE_INSTANCE_INVALID_SUPERSEDES:${reading.id}`);
    return reading;
  }
  if (
    prior === undefined &&
    collision !== undefined &&
    collision.supersedes === undefined &&
    measurement(collision) === measurement(reading)
  ) {
    return collision;
  }
  const { id: _id, supersedes: _supersedes, ...body } = reading;
  const instance = {
    ...body,
    ...(prior === undefined ? {} : { supersedes: prior.id }),
  };
  const id = `SR-${createHash('sha256')
    .update(canonicalJson({ head, reading: instance }))
    .digest('hex')
    .slice(0, 16)}`;
  const result = { ...instance, id };
  if (!validators.sensorReading(result)) throw new Error('SENSE_INSTANCE_INVALID_RESULT');
  const existing = stored.get(id);
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(result)) {
    throw new Error(`SENSE_RECORD_ID_CONFLICT:${id}`);
  }
  return result;
}
