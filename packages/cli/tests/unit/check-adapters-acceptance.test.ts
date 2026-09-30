// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: the canonical check facade must keep migrated check
// services executable, total, and fail-closed without recursing into test floors.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import {
  knownCheckMembers,
  resolveCheckPlan,
  runCheckPlan,
  type ResolvedCheckMember,
} from '../../src/commands/check/contracts.js';

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

  it('declares the two suite members and the two planning-lane members, and no other', () => {
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      member_definitions: Array<{ id: string; binding: unknown }>;
      suites: Array<{ members: string[] }>;
    };
    expect(policy.member_definitions.map((entry) => entry.id)).toEqual([
      'ledger-local',
      'ledger-rc',
      'campaign',
      'scorecard-page',
    ]);
    expect([...new Set(policy.suites.flatMap((suite) => suite.members))].sort()).toEqual([
      'ledger-local',
      'ledger-rc',
    ]);
    // ADR-CHK-0003: the planning-lane members bind the exact argv the adapter runs.
    expect(policy.member_definitions.slice(2)).toEqual([
      {
        id: 'campaign',
        binding: { kind: 'literal-argv', argv: ['node', 'scripts/check-campaign.mjs'] },
        effect: 'read',
        cost: 'low',
        output: 'action-envelope-plus-campaign-report',
        applicability: 'self',
      },
      {
        id: 'scorecard-page',
        binding: {
          kind: 'literal-argv',
          argv: ['node', 'scripts/generate-scorecard-page.mjs', '--check'],
        },
        effect: 'read',
        cost: 'low',
        output: 'action-envelope-plus-scorecard-page-report',
        applicability: 'self',
      },
    ]);
  });

  it('declares applicability for every member and every --only selector the CLI accepts', () => {
    // ADR-CHK-0005: the policy declarations and the hardcoded selector set agree exactly.
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      member_definitions: Array<{ id: string; applicability?: unknown }>;
      selector_definitions: Array<{ id: string; applicability?: unknown }>;
    };
    const members = policy.member_definitions.map((entry) => entry.id);
    const selectors = policy.selector_definitions.map((entry) => entry.id);
    expect(policy.member_definitions.map((entry) => [entry.id, entry.applicability])).toEqual([
      ['ledger-local', 'both'],
      ['ledger-rc', 'both'],
      ['campaign', 'self'],
      ['scorecard-page', 'self'],
    ]);
    expect(selectors).toHaveLength(26);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(selectors.filter((id) => members.includes(id))).toEqual([]);
    expect(knownCheckMembers(ROOT)).toEqual([...members, ...selectors].sort());
    expect(
      policy.selector_definitions
        .filter((entry) => entry.applicability === 'self')
        .map((entry) => entry.id),
    ).toEqual(['action-effects', 'cli-reference', 'prompt-overlays']);
    for (const entry of [...policy.member_definitions, ...policy.selector_definitions]) {
      expect(['self', 'adopter', 'both']).toContain(entry.applicability);
    }
  });

  it('carries not-applicable as its own result class in the aggregate report', async () => {
    const plan = resolveCheckPlan(ROOT, { only: 'action-effects' });
    const notApplicable = await runCheckPlan(plan, (entry) => ({
      id: entry.id,
      status: 'na',
      effect: entry.effect,
      binding: entry.binding,
      duration_ms: 0,
      code: 'CHECK_MEMBER_NOT_APPLICABLE',
    }));
    expect(notApplicable).toMatchObject({
      ok: false,
      execution_status: 'pass',
      readiness_status: 'na',
      exit_code: 0,
      counts: { pass: 0, review: 0, fail: 0, unknown: 0, na: 1, error: 0 },
    });
    expect(notApplicable.results[0]).toMatchObject({
      status: 'na',
      code: 'CHECK_MEMBER_NOT_APPLICABLE',
    });
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
