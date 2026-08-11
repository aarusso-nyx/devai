import { createHash } from 'node:crypto';
import { validators } from '@devai-nyx/schemas';
import type { SensorKind } from './sensor-registry.js';

export type { SensorKind } from './sensor-registry.js';

export type SensorStatus = 'pass' | 'fail' | 'review' | 'skipped' | 'killed' | 'error' | 'unknown';

export type FindingSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface SensorFinding {
  readonly severity: FindingSeverity;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly invariant_id?: string;
}

/**
 * Sensor latency/scope tier (Phase 16.D, D-50). Optional during the
 * substrate-only phase; sensor adapters that opt in declare their
 * tier so progressive-gate consumers can filter readings by cycle.
 *   L0: static analysis — lint, typecheck, build, dead-code, dep-audit
 *   L1: dynamic — unit, integration, API-contract, smoke
 *   L2: integrity — coverage thresholds, hard-fail checks, agent-registry checks
 *   semantic: trace resolution, adherence audit, prompt firewall, runtime arbiter
 */
export type SensorTier = 'L0' | 'L1' | 'L2' | 'semantic';

export interface SensorReadingInput {
  readonly lifecycle?: 'supported' | 'experimental';
  readonly sensorName: string;
  readonly sensorKind: SensorKind;
  readonly sensorVersion?: string;
  readonly command: readonly string[];
  readonly status: SensorStatus;
  readonly deterministic: boolean;
  readonly tier?: SensorTier;
  readonly timestamp?: string;
  readonly exit_code?: number;
  readonly duration_ms?: number;
  readonly out_head?: string;
  readonly err_head?: string;
  readonly killed?: boolean;
  readonly evidence_path?: string;
  readonly findings?: readonly SensorFinding[];
  readonly metrics?: Readonly<Record<string, number | string | boolean>>;
  /**
   * Phase 30.D (closes W-2): when true, include `timestamp` in the
   * canonical id hash so successive runs of the same sensor against
   * identical state produce distinct SR files (rather than
   * overwriting the same content-addressed name). Default false
   * preserves Phase 21.E content-addressed semantics for the
   * majority of sensors; sensors that need every-run evidence
   * (`sense-test-weakening` is the canonical case) opt in.
   */
  readonly forceUniqueId?: boolean;
}

export interface SensorIdentity {
  name: string;
  kind: SensorKind;
  version?: string;
}

export interface SensorReading {
  schemaVersion: '1.0.0';
  lifecycle?: 'supported' | 'experimental';
  id: string;
  sensor: SensorIdentity;
  timestamp: string;
  status: SensorStatus;
  deterministic: boolean;
  command: string;
  command_hash: string;
  tier?: SensorTier;
  exit_code?: number;
  duration_ms?: number;
  out_head?: string;
  err_head?: string;
  killed?: boolean;
  evidence_path?: string;
  findings?: SensorFinding[];
  metrics?: Record<string, number | string | boolean>;
}

const HEAD_LIMIT = 2048;

export function buildSensorReading(input: SensorReadingInput): SensorReading {
  const command = input.command.join(' ');
  const command_hash = createHash('sha256').update(command).digest('hex');
  const timestamp = input.timestamp ?? new Date().toISOString();

  const canonicalForId = JSON.stringify([
    input.sensorName,
    input.sensorKind,
    command_hash,
    input.status,
    [...(input.findings ?? [])]
      .map((f) => `${f.severity}:${f.code}:${f.file ?? ''}:${f.line ?? 0}`)
      .sort(),
    // Phase 30.D (W-2): opt-in timestamp inclusion for sensors
    // that need every-run evidence.
    input.forceUniqueId === true ? timestamp : '',
  ]);
  const id = `SR-${createHash('sha256').update(canonicalForId).digest('hex').slice(0, 16)}`;

  const sensor: SensorIdentity = { name: input.sensorName, kind: input.sensorKind };
  if (input.sensorVersion !== undefined) sensor.version = input.sensorVersion;

  const reading: SensorReading = {
    schemaVersion: '1.0.0',
    ...(input.lifecycle !== undefined && { lifecycle: input.lifecycle }),
    id,
    sensor,
    timestamp,
    status: input.status,
    deterministic: input.deterministic,
    command,
    command_hash,
  };
  if (input.tier !== undefined) reading.tier = input.tier;
  if (input.exit_code !== undefined) reading.exit_code = input.exit_code;
  if (input.duration_ms !== undefined) reading.duration_ms = input.duration_ms;
  if (input.out_head !== undefined) reading.out_head = input.out_head.slice(0, HEAD_LIMIT);
  if (input.err_head !== undefined) reading.err_head = input.err_head.slice(0, HEAD_LIMIT);
  if (input.killed !== undefined) reading.killed = input.killed;
  if (input.evidence_path !== undefined) reading.evidence_path = input.evidence_path;
  if (input.findings !== undefined) reading.findings = [...input.findings];
  if (input.metrics !== undefined) reading.metrics = { ...input.metrics };

  // Hard gate: every SensorReading emitted by the framework MUST validate
  // against sensor-reading.schema.json. Per CLAUDE.md §"Schema instances
  // validate against schemas" and Constitution Article 32 (sensor adapter
  // uniformity), an invalid reading is a programming error in the builder
  // or its caller — surface it loudly rather than emit silently bad data.
  const ok = validators.sensorReading(reading);
  if (!ok) {
    throw new Error(
      `buildSensorReading: constructed reading does not validate against sensor-reading.schema.json: ${JSON.stringify(validators.sensorReading.errors)}`,
    );
  }
  return reading;
}
