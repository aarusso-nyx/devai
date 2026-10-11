// ADR-SCR-0018: output completeness never implies effect approval.
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const validate = getValidator('workflow-step-inventory.schema.json');
function complete() {
  return {
    schemaVersion: '1.0.0',
    status: 'complete',
    reason: null,
    workflows: [
      {
        path: '.github/workflows/a.yml',
        sha256: 'a'.repeat(64),
        status: 'complete',
        reason: null,
        steps: [0, 1].map((index) => ({
          job: 'verify',
          index,
          occurrence: `.github/workflows/a.yml#verify[${index}]`,
          name: 'Inspect',
          sha256: 'b'.repeat(64),
          closure: {
            status: 'complete',
            reason: null,
            files: [{ path: 'scripts/main.mjs', sha256: 'c'.repeat(64) }],
          },
        })),
      },
    ],
  };
}
describe('workflow step inventory output contract', () => {
  it('validates distinct physical occurrences sharing a canonical digest and separate raw identity', () => {
    const value = complete();
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(value.workflows[0]?.steps.map((row) => row.index)).toEqual([0, 1]);
    expect(value.workflows[0]?.steps.map((row) => row.sha256)).toEqual([
      'b'.repeat(64),
      'b'.repeat(64),
    ]);
    expect(value.workflows[0]?.sha256).toBe('a'.repeat(64));
  });
  it('validates explicit empty and incomplete populations with no partial complete closure', () => {
    expect(
      validate({
        schemaVersion: '1.0.0',
        status: 'unknown',
        reason: 'WORKFLOW_INVENTORY_EMPTY',
        workflows: [],
      }),
    ).toBe(true);
    const value = complete();
    const file = value.workflows[0];
    if (file === undefined) throw new Error('Missing fixture workflow');
    const unknown = {
      ...value,
      status: 'unknown',
      reason: 'WORKFLOW_INVENTORY_INCOMPLETE',
      workflows: [
        {
          ...file,
          status: 'unknown',
          reason: 'WORKFLOW_INVENTORY_INCOMPLETE',
          steps: file.steps.map((row) => ({
            ...row,
            closure: { status: 'unknown', files: null, reason: 'Unproved import selection' },
          })),
        },
      ],
    };
    expect(validate(unknown), JSON.stringify(validate.errors)).toBe(true);
    const partial = structuredClone(unknown);
    Object.assign(partial.workflows[0]?.steps[0]?.closure ?? {}, {
      files: [{ path: 'scripts/main.mjs', sha256: 'c'.repeat(64) }],
    });
    expect(validate(partial)).toBe(false);
  });
  it.each([
    'empty-complete',
    'empty-workflow-steps',
    'unknown-complete-step',
    'missing-digest',
    'unknown-workflow-complete-step-without-digest',
    'unsafe-path',
    'effect-field',
    'review-field',
    'complete-reason',
    'hard-refusal-as-value',
  ] as const)('refuses %s output', (variant) => {
    const value = complete();
    const step = value.workflows[0]?.steps[0];
    if (variant === 'empty-complete') value.workflows = [];
    if (variant === 'empty-workflow-steps') Object.assign(value.workflows[0] ?? {}, { steps: [] });
    if (variant === 'unknown-complete-step')
      Object.assign(step?.closure ?? {}, { status: 'unknown', files: null, reason: 'Unproved' });
    if (variant === 'missing-digest') Object.assign(step ?? {}, { sha256: null });
    if (variant === 'unknown-workflow-complete-step-without-digest') {
      Object.assign(value, { status: 'unknown', reason: 'WORKFLOW_INVENTORY_INCOMPLETE' });
      Object.assign(value.workflows[0] ?? {}, {
        status: 'unknown',
        reason: 'WORKFLOW_INVENTORY_INCOMPLETE',
      });
      Object.assign(step ?? {}, { sha256: null });
    }
    if (variant === 'unsafe-path')
      Object.assign(step?.closure.files[0] ?? {}, { path: '../external.mjs' });
    if (variant === 'effect-field') Object.assign(step ?? {}, { effect: 'read-only' });
    if (variant === 'review-field')
      Object.assign(step ?? {}, { review: 'This is not an approval surface.' });
    if (variant === 'complete-reason')
      Object.assign(value, { reason: 'WORKFLOW_INVENTORY_INCOMPLETE' });
    if (variant === 'hard-refusal-as-value')
      Object.assign(value, { status: 'unknown', reason: 'WORKFLOW_INVENTORY_CHANGED' });
    expect(validate(value)).toBe(false);
  });
});
