import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec idiomaticity (F1 × T5). Phase 26.C (closes
 * D-77 sub-batch 26.C). Wraps the in-process `validateInvariants`
 * with `strictCnl: true`, which flags `statement:` fields lacking a
 * recognized CNL modal verb (MUST/SHOULD/MAY/...). Emits a
 * SensorReading whose status reflects whether the invariant
 * population is uniformly CNL-conformant.
 *
 * Status semantics:
 *   - PASS: validator returns ok=true under strict-cnl (zero modal
 *     warnings; everything else passes too).
 *   - REVIEW: validator returns ok=true but errors carry
 *     `code='STATEMENT_LACKS_CNL_MODAL'` warnings (these are not
 *     hard-fail under the validator's contract but signal non-uniform
 *     style).
 *   - FAIL: validator returns ok=false (any error severity).
 *
 * The "wraps existing tooling" pattern matches 26.F (test-coverage-
 * depth wraps the coverage parser) and 26.H (inventory-adherence
 * wraps inv-adherence-reverse). The sensor is intentionally a thin
 * shell around the canonical validator so the F1×T5 cell stays
 * coherent with whatever `spec validate-invariants` reports.
 */

export interface SpecValidationLikeError {
  readonly severity?: 'error' | 'warning' | 'warn' | 'info';
  readonly code?: string;
  readonly message?: string;
  readonly file?: string;
}

export interface SpecValidationLikeResult {
  readonly ok: boolean;
  readonly errors: readonly SpecValidationLikeError[];
  readonly files_scanned?: number;
}

export interface SpecIdiomaticityOptions {
  /**
   * Caller supplies the validator result (the sensor doesn't load
   * domains itself — that's a CLI concern). The CLI wrapper at
   * `commands/sense/spec-idiomaticity.ts` constructs the result via
   * `validateInvariants` with `strictCnl: true`.
   */
  readonly validationResult: SpecValidationLikeResult;
  readonly now?: string;
}

const MODAL_CODE = 'STATEMENT_LACKS_CNL_MODAL';

function mapValidatorErrorSeverity(
  s: SpecValidationLikeError['severity'],
): SensorFinding['severity'] {
  switch (s) {
    case 'warn':
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'error':
    default:
      return 'error';
  }
}

export function senseSpecIdiomaticity(opts: SpecIdiomaticityOptions): SensorReading {
  const { validationResult } = opts;
  const modalWarnings = validationResult.errors.filter((e) => e.code === MODAL_CODE);
  const otherErrors = validationResult.errors.filter((e) => e.code !== MODAL_CODE);

  // Phase 30 lane D: the validator returns ok=false whenever there's
  // ANY entry in errors, including warning-severity ones like the
  // CNL-modal check. The sensor should treat those as REVIEW, not
  // FAIL — fail only on entries whose severity is genuinely 'error'
  // (severity defaults to 'error' when absent, preserving pre-30 strict
  // behaviour for callers that haven't adopted severity yet).
  const hardErrors = otherErrors.filter((e) => (e.severity ?? 'error') === 'error');
  let status: SensorStatus;
  if (hardErrors.length > 0) {
    status = 'fail';
  } else if (modalWarnings.length > 0) {
    status = 'review';
  } else {
    status = 'pass';
  }

  const findings: SensorFinding[] = validationResult.errors.map((e) => ({
    severity: mapValidatorErrorSeverity(e.severity),
    code: e.code ?? 'UNKNOWN',
    message: e.message ?? '',
    ...(e.file !== undefined && { file: e.file }),
  }));

  return buildSensorReading({
    sensorName: 'spec-idiomaticity',
    sensorKind: 'spec_idiomaticity',
    command: ['devai', 'sense-spec-idiomaticity'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      cnl_modal_warnings: modalWarnings.length,
      other_errors: otherErrors.length,
      files_scanned: validationResult.files_scanned ?? 0,
    },
  });
}
