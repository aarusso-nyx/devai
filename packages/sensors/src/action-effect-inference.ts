import {
  analyzeEffectProgram,
  type EffectContract,
  type EffectReport,
  type SubprocessTemplate,
} from '@devai-nyx/effects-check';
import { buildSensorReading, type SensorFinding, type SensorReading } from './sensor-reading.js';

export interface ActionEffectInferenceOptions {
  readonly tsconfigPath: string;
  readonly catalog: readonly string[];
  readonly contracts: readonly EffectContract[];
  readonly subprocessRegistry: Readonly<{ templates: readonly SubprocessTemplate[] }>;
}

export interface ActionEffectInferenceResult {
  readonly report: EffectReport;
  readonly reading: SensorReading;
}

export async function senseActionEffectInference(
  options: ActionEffectInferenceOptions,
): Promise<ActionEffectInferenceResult> {
  const report = await analyzeEffectProgram(options);
  const findings: SensorFinding[] = report.findings.map((finding) => ({
    severity: 'warning',
    code: finding.code,
    message: finding.message,
    invariant_id: 'INV-DEVAI-020',
  }));
  return {
    report,
    reading: buildSensorReading({
      lifecycle: 'experimental',
      sensorName: 'action-effect-inference',
      sensorKind: 'action_effect_inference',
      sensorVersion: '1.0.0-shadow',
      command: ['devai', 'policy', 'check', 'action', 'effects'],
      status: findings.length === 0 ? 'pass' : 'review',
      deterministic: true,
      tier: 'L0',
      duration_ms: report.metrics.duration_ms,
      findings,
      metrics: {
        catalog_actions: report.metrics.catalog_actions,
        extracted_actions: report.metrics.extracted_actions,
        unresolved_edges: report.metrics.unresolved_edges,
        dispositioned_edges: report.metrics.dispositioned_edges,
      },
    }),
  };
}
