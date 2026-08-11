// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: the canonical check facade must keep migrated check
// services executable, total, and fail-closed without recursing into test floors.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import { resolveCheckPlan, type ResolvedCheckMember } from '../../src/commands/check/contracts.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'devai-r0007-check-acceptance-'));

function member(serviceId: string): ResolvedCheckMember {
  return {
    id: serviceId,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect: serviceId === 'translation' ? 'local-write' : 'read',
    cost: 'low',
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

async function execute(serviceId: string, options: Readonly<Record<string, unknown>> = {}) {
  return withAuthorityHostTestScope(() =>
    executeCheckMember(member(serviceId), { repoRoot: ROOT, ...options }),
  );
}

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true });
});

describe('canonical check adapter acceptance', () => {
  it('routes every suite through exactly one content-addressed ledger service', () => {
    for (const suite of ['quick', 'standard'] as const) {
      expect(resolveCheckPlan(ROOT, { suite }).members.map((entry) => entry.service_id)).toEqual([
        'ledger-local',
      ]);
    }
    for (const suite of ['full', 'release'] as const) {
      expect(resolveCheckPlan(ROOT, { suite }).members.map((entry) => entry.service_id)).toEqual([
        'ledger-rc',
      ]);
    }
  });

  it('retains only the two suite members referenced by the public suite population', () => {
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      member_definitions: Array<{ id: string; binding: unknown }>;
    };
    expect(policy.member_definitions.map((entry) => entry.id)).toEqual([
      'ledger-local',
      'ledger-rc',
    ]);
  });

  it('executes every non-recursive read-safe check service as a total structured result', async () => {
    const prBody = join(FIXTURE_ROOT, 'pr-body.md');
    writeFileSync(prBody, '## Verification\n\n- Inspector acceptance\n', 'utf8');

    const services: ReadonlyArray<
      readonly [serviceId: string, options?: Readonly<Record<string, unknown>>]
    > = [
      ['schema-config-load'],
      ['schemas'],
      ['invariant-validation'],
      ['invariants'],
      ['journey-validation'],
      ['journeys'],
      ['glossary-validation'],
      ['glossary'],
      ['trace-validation'],
      ['trace'],
      ['test-trace-validation'],
      ['test-trace'],
      ['strategy-validation'],
      ['invariant-strategies'],
      ['action-coverage'],
      ['inventory-integrity'],
      ['mutation'],
      ['mutation-verification'],
      ['release-scorecard'],
      ['dependency-security'],
      ['dependencies'],
      ['provenance-readiness'],
      ['cli-reference'],
      ['docs-links'],
      ['adrs'],
      ['ci-economy'],
      ['docs-governance', { skipPublishCheck: true }],
      ['forbidden-actions', { maxCommits: 1 }],
      ['glob-guards'],
      ['overrides'],
      ['pr-compliance', { prBodyFile: prBody, optional: true }],
      ['prompt-overlays'],
      ['sensor-integrity'],
    ];

    const results = [];
    for (const [serviceId, options] of services) {
      results.push(await execute(serviceId, options));
    }

    expect(results).toHaveLength(services.length);
    expect(results.map((result) => result.id)).toEqual(services.map(([serviceId]) => serviceId));
    expect(
      results.every(
        (result) =>
          Number.isInteger(result.duration_ms) &&
          result.duration_ms >= 0 &&
          ['pass', 'review', 'fail', 'unknown', 'na', 'error'].includes(result.status),
      ),
    ).toBe(true);
    expect(results.filter((result) => result.code === 'CHECK_SERVICE_ERROR')).toEqual([]);
  }, 120_000);

  it('returns structured validation failures for bounded migrated inputs', async () => {
    const schema = join(FIXTURE_ROOT, 'schema.json');
    const validInstance = join(FIXTURE_ROOT, 'valid.json');
    const invalidInstance = join(FIXTURE_ROOT, 'invalid.json');
    writeFileSync(
      schema,
      `${JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { const: true } } })}\n`,
      'utf8',
    );
    writeFileSync(validInstance, '{"ok":true}\n', 'utf8');
    writeFileSync(invalidInstance, '{"ok":false}\n', 'utf8');

    const valid = await execute('schema', { schema, instance: validInstance });
    const invalid = await execute('schema', { schema, instance: invalidInstance });
    const missingSchemaInput = await execute('schema');
    const missingBlueprintInput = await execute('blueprint');
    const missingTranslationInput = await execute('translation');
    const unknown = await execute('not-a-check-service');

    expect(valid.status).toBe('pass');
    expect(invalid.status).toBe('fail');
    for (const result of [
      missingSchemaInput,
      missingBlueprintInput,
      missingTranslationInput,
      unknown,
    ]) {
      expect(result).toMatchObject({ status: 'error', code: 'CHECK_SERVICE_ERROR' });
    }
    expect(missingSchemaInput.message).toContain('CHECK_SCHEMA_INPUT_REQUIRED');
    expect(missingBlueprintInput.message).toContain('CHECK_BLUEPRINT_FILE_REQUIRED');
    expect(missingTranslationInput.message).toContain('CHECK_TRANSLATION_WITNESS_REQUIRED');
    expect(unknown.message).toContain('CHECK_SERVICE_UNKNOWN');
  });
});
