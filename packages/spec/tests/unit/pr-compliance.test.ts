import { describe, expect, it } from 'vitest';
import { checkPrCompliance } from '../../src/pr-compliance/index.js';

describe('PR invariant compliance trailers', () => {
  it('requires a trailer by default but allows an explicitly optional absence', () => {
    expect(checkPrCompliance({ body: 'ordinary description' })).toMatchObject({
      ok: false,
      cited_ids: [],
      findings: [{ code: 'missing-trailer' }],
    });
    expect(checkPrCompliance({ body: '', required: false })).toEqual({
      ok: true,
      cited_ids: [],
      findings: [],
    });
  });

  it.each(['', ' ', '\t', ', ,'])(
    'reports an empty trailer without consuming the next line: %j',
    (value) => {
      expect(checkPrCompliance({ body: `Inv-Compliance:${value}\nINV-AUTH-001` })).toMatchObject({
        ok: false,
        cited_ids: [],
        findings: [{ code: 'empty-trailer' }],
      });
    },
  );

  it('trims and deduplicates IDs while preserving first citation order', () => {
    expect(
      checkPrCompliance({
        body: 'Summary\ninv-compliance: INV-SEC-002, INV-AUTH-001, INV-SEC-002, ,\r\nDetails',
        invariant_ids: new Set(['INV-SEC-002', 'INV-AUTH-001']),
      }),
    ).toEqual({ ok: true, cited_ids: ['INV-SEC-002', 'INV-AUTH-001'], findings: [] });
  });

  it('reports malformed and unknown IDs independently even when the trailer is optional', () => {
    const result = checkPrCompliance({
      body: 'Inv-Compliance: bad, INV-AUTH-001, bad, INV-SEC-002',
      required: false,
      invariant_ids: new Set(['INV-SEC-002']),
    });
    expect(result.ok).toBe(false);
    expect(result.cited_ids).toEqual(['bad', 'INV-AUTH-001', 'INV-SEC-002']);
    expect(result.findings.map(({ code, invariant_id }) => ({ code, invariant_id }))).toEqual([
      { code: 'malformed-id', invariant_id: 'bad' },
      { code: 'unknown-id', invariant_id: 'INV-AUTH-001' },
    ]);
  });

  it.each([
    'INV-A-001',
    'INV-1A-001',
    'INV-auth-001',
    'INV-AUTH-01',
    'INV-AUTH-0001',
    'xINV-AUTH-001',
    'INV-AUTH-001x',
    'INV-ABCDEFGHIJKLMNOPQ-001',
  ])('rejects malformed identifier %s', (id) => {
    expect(checkPrCompliance({ body: `Inv-Compliance: ${id}` })).toMatchObject({
      ok: false,
      findings: [{ code: 'malformed-id', invariant_id: id }],
    });
  });

  it.each(['INV-A1-000', 'INV-ABCDEFGHIJKLMNOP-999'])(
    'accepts grammar boundaries without an optional catalog: %s',
    (id) => {
      expect(checkPrCompliance({ body: `Inv-Compliance: ${id}` })).toEqual({
        ok: true,
        cited_ids: [id],
        findings: [],
      });
    },
  );

  it('does not recognize an embedded prose fragment as a trailer', () => {
    expect(
      checkPrCompliance({ body: 'Example Inv-Compliance: INV-AUTH-001' }).findings[0]?.code,
    ).toBe('missing-trailer');
  });
});
