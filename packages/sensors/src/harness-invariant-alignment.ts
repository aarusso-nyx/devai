import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

import { loadWorkflows } from './harness/workflow-parser.js';
import { loadRunSteps, hasExecutableMeasurement } from './harness-invariant-alignment-workflow.js';
import {
  safeStat,
  candidateHead,
  loadEvidence,
  hasFreshCandidateEvidence,
} from './harness-invariant-alignment-evidence.js';

/**
 * F5 harness invariant-alignment sensor (28.E; F5×T4). Per design
 * note at docs/theory/architecture/sensors/harness_invariant_alignment.md.
 */

export interface HarnessInvariantAlignmentOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly workflowDir?: string;
  readonly gateSeverityValue?: string;
  /** Candidate whose successful observations may promote alignment. */
  readonly candidateHead?: string;
  /** Directory containing persisted readings/evidence. */
  readonly evidenceDir?: string;
  /** Maximum age of candidate-bound evidence. Defaults to 24 hours. */
  readonly maxEvidenceAgeHours?: number;
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

interface InvariantRecord {
  readonly id?: string;
  readonly severity?: string;
  readonly measurable_via?: readonly string[];
  readonly measurable_via_mode?: 'any' | 'all';
}

function loadInvariants(dir: string): InvariantRecord[] {
  const st = safeStat(dir);
  if (st === null || !st.isDirectory()) return [];
  const out: InvariantRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, e), 'utf8')) as InvariantRecord);
    } catch {
      // skip
    }
  }
  return out;
}

export function senseHarnessInvariantAlignment(
  opts: HarnessInvariantAlignmentOptions,
): SensorReading {
  const gateSeverity = opts.gateSeverityValue ?? 'gate';
  const invariants = loadInvariants(
    abs(opts.repoRoot, opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR),
  );
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const runSteps = loadRunSteps(workflows.map((workflow) => workflow.file));
  const resolvedCandidateHead = candidateHead(opts.repoRoot, opts.candidateHead);
  const evidence =
    opts.evidenceDir !== undefined
      ? loadEvidence(opts.repoRoot, abs(opts.repoRoot, opts.evidenceDir))
      : [
          ...loadEvidence(opts.repoRoot, abs(opts.repoRoot, 'record/proofs/sensor-readings')),
          ...loadEvidence(opts.repoRoot, abs(opts.repoRoot, 'record/proofs/work/test-results')),
        ];
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const maxEvidenceAgeHours = opts.maxEvidenceAgeHours ?? 24;
  const maxAgeMs = maxEvidenceAgeHours * 60 * 60 * 1000;

  const gates = invariants.filter((i) => i.severity === gateSeverity);
  if (gates.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-invariant-alignment',
      sensorKind: 'harness_invariant_alignment',
      command: ['devai', 'sense-harness-invariant-alignment'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_INVARIANT_ALIGNMENT_NO_GATES',
          message: `No invariants with severity="${gateSeverity}" found.`,
        },
      ],
      metrics: { gate_invariants: 0, misaligned: 0 },
    });
  }

  const findings: SensorFinding[] = [];
  let misaligned = 0;
  for (const inv of gates) {
    const id = inv.id ?? '<unknown>';
    const candidates = inv.measurable_via ?? [];
    if (candidates.length === 0) {
      misaligned += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_INVARIANT_ALIGNMENT_NO_MEASURABLE_VIA',
        message: `Gate invariant ${id} has no measurable_via[] entries to align against CI.`,
      });
      continue;
    }
    // R18.C.5 (D-133/M1): measurable_via_mode 'all' (invariant schema,
    // Constitution-0.5.0-era addition) marks invariants whose statement
    // needs every listed observation — one verb's textual presence must not
    // count the whole invariant as measured. Default stays 'any' (back-compat).
    const executable = (candidate: string): boolean =>
      hasExecutableMeasurement(runSteps, candidate);
    const matched = (candidate: string): boolean => {
      if (!executable(candidate)) return false;
      if (resolvedCandidateHead === undefined || !/^[0-9a-f]{40}$/i.test(resolvedCandidateHead)) {
        return false;
      }
      return hasFreshCandidateEvidence(
        opts.repoRoot,
        evidence,
        candidate,
        resolvedCandidateHead,
        nowMs,
        maxAgeMs,
      );
    };
    const mode = inv.measurable_via_mode ?? 'any';
    const aligned = mode === 'all' ? candidates.every(matched) : candidates.some(matched);
    if (!aligned) {
      misaligned += 1;
      const missing = mode === 'all' ? candidates.filter((c) => !matched(c)) : candidates;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
        message:
          mode === 'all'
            ? `Gate invariant ${id} requires ALL of measurable_via=[${candidates.join(', ')}] in CI (measurable_via_mode=all); missing: [${missing.join(', ')}].`
            : `Gate invariant ${id} has measurable_via=[${candidates.join(', ')}] but none has an executable fail-closed CI step with fresh successful candidate-bound evidence.`,
      });
    }
  }

  let status: SensorStatus;
  if (misaligned === 0) status = 'pass';
  else if (misaligned <= 2) status = 'review';
  else status = 'fail';

  return buildSensorReading({
    sensorName: 'harness-invariant-alignment',
    sensorKind: 'harness_invariant_alignment',
    command: ['devai', 'sense-harness-invariant-alignment'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      gate_invariants: gates.length,
      misaligned,
      workflow_count: workflows.length,
      executable_run_steps: runSteps.length,
      evidence_records: evidence.length,
      candidate_head_resolved: resolvedCandidateHead !== undefined,
    },
  });
}
