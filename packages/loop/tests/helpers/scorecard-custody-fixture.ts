import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeManifestHash, type EvidenceChain } from '@devai-nyx/evidence';
import type { SensorReading } from '@devai-nyx/sensors';

/** A canonical reading plus a cryptographically valid chain entry for a fixture candidate. */
export function recordBoundScorecardReading(
  root: string,
  reading: SensorReading,
  head: string,
): string {
  const path = `.devai/state/sensor-readings/${reading.sensor.kind}/${reading.id}.json`;
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = `${JSON.stringify(reading, null, 2)}\n`;
  writeFileSync(target, bytes);
  const chainPath = join(root, 'record/proofs/chain.json');
  mkdirSync(dirname(chainPath), { recursive: true });
  const chain: EvidenceChain = existsSync(chainPath)
    ? (JSON.parse(readFileSync(chainPath, 'utf8')) as EvidenceChain)
    : { head: null, records: [] };
  const id = `EV-${(chain.records.length + 1).toString(16).padStart(16, '0')}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const identity = {
    id,
    timestamp: reading.timestamp,
    actor: 'fixture',
    actor_role: 'harness',
    action: 'sense.readings.record',
    status: 'completed',
  };
  const manifest_hash = computeManifestHash({
    ...identity,
    git_head_sha: head,
    artifact_sha256s: [sha256],
    previous_run_hash: chain.head,
  });
  chain.records.push({
    schemaVersion: '1.0.0',
    ...identity,
    context: { repo_root: root, git: { head_sha: head, dirty_files: [] } },
    artifacts: [{ path, sha256, kind: 'sensor-reading' }],
    previous_run_hash: chain.head,
    manifest_hash,
    sequence: chain.records.length + 1,
    previous_hash: chain.head ?? 'GENESIS',
  });
  chain.head = manifest_hash;
  writeFileSync(chainPath, `${JSON.stringify(chain, null, 2)}\n`);
  return target;
}
