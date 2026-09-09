import { describe, expect, it } from 'vitest';
import { senseSpecIdiomaticity } from '../../src/spec-idiomaticity.js';

const NOW = '2026-09-08T12:00:00.000Z';

describe('spec idiomaticity validation populations', () => {
  it('passes an empty validation error population while retaining file count', () => {
    const reading = senseSpecIdiomaticity({
      validationResult: { ok: true, errors: [], files_scanned: 4 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      sensor: { name: 'spec-idiomaticity', kind: 'spec_idiomaticity' },
      command: 'devai sense-spec-idiomaticity',
      timestamp: NOW,
      metrics: { cnl_modal_warnings: 0, other_errors: 0, files_scanned: 4 },
      findings: [],
    });
  });

  it('reviews modal warnings and maps mixed non-hard severities without failing', () => {
    const reading = senseSpecIdiomaticity({
      validationResult: {
        ok: true,
        files_scanned: 3,
        errors: [
          {
            code: 'STATEMENT_LACKS_CNL_MODAL',
            severity: 'warning',
            message: 'statement lacks MUST',
            file: 'law/invariants/one.json',
          },
          {
            code: 'STATEMENT_LACKS_CNL_MODAL',
            severity: 'warn',
            message: 'statement lacks SHOULD',
          },
          { code: 'ADVISORY_NOTE', severity: 'info', message: 'style note' },
        ],
      },
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({
      cnl_modal_warnings: 2,
      other_errors: 1,
      files_scanned: 3,
    });
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'STATEMENT_LACKS_CNL_MODAL',
        message: 'statement lacks MUST',
        file: 'law/invariants/one.json',
      },
      { severity: 'warning', code: 'STATEMENT_LACKS_CNL_MODAL', message: 'statement lacks SHOULD' },
      { severity: 'info', code: 'ADVISORY_NOTE', message: 'style note' },
    ]);
  });

  it('fails when a non-modal error is hard, including an omitted severity', () => {
    const reading = senseSpecIdiomaticity({
      validationResult: {
        ok: false,
        errors: [
          { code: 'STATEMENT_LACKS_CNL_MODAL', severity: 'warning', message: 'needs a modal' },
          { code: 'SCHEMA_INVALID', severity: 'error', message: 'invalid invariant' },
          { code: 'LEGACY_INVALID', message: 'severity defaults to error' },
        ],
      },
      now: NOW,
    });

    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({ cnl_modal_warnings: 1, other_errors: 2 });
    expect(reading.findings).toEqual([
      { severity: 'warning', code: 'STATEMENT_LACKS_CNL_MODAL', message: 'needs a modal' },
      { severity: 'error', code: 'SCHEMA_INVALID', message: 'invalid invariant' },
      { severity: 'error', code: 'LEGACY_INVALID', message: 'severity defaults to error' },
    ]);
  });
});
