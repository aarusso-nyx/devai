import { describe, expect, it } from 'vitest';
import {
  CONSENT,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  engineerRule,
  expectSuccess,
  fsTarget,
  inspectorRule,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

async function resolve(rules: readonly unknown[], resource: Record<string, unknown> = fsTarget) {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  try {
    const plant = makePolicyPlant({ additiveRules: rules });
    const loaded = expectSuccess<{ provenance: unknown }>(
      api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
    );
    const declaration = expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(issuer, actionDocument(), undefined, loaded.provenance),
      ),
    );
    return api.resolveAuthorityPolicy(
      loaded,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource,
        operation: resource.operation,
      },
      { receiptStore: issuer, canonicalSha256 },
    );
  } finally {
    issuer.dispose();
  }
}
const renamed = {
  ...fsTarget,
  operation: 'rename',
  canonical_relative_path: 'packages/core/src/new.ts',
  rename_from_canonical_relative_path: 'packages/core/src/old.ts',
};

describe('policy precedence and rename classification', () => {
  it('refuses equally ranked contradictory effects with sorted rule identities', async () => {
    const rules = [
      { ...engineerRule, rule_id: 'z-allow' },
      { ...engineerRule, rule_id: 'a-deny', effect: 'deny' },
    ];
    expect(await resolve(rules)).toMatchObject({
      outcome: 'deny',
      code: 'AMBIGUOUS_POLICY_MATCH',
      matched_rule_ids: ['a-deny', 'z-allow'],
    });
  });

  it('allows equal-rank agreeing rules and retains every matched identity', async () => {
    const result = (await resolve([
      { ...engineerRule, rule_id: 'z-allow' },
      { ...engineerRule, rule_id: 'a-allow' },
    ])) as { matched_rule_ids: string[] };
    expect(result).toMatchObject({
      outcome: 'allow',
      code: 'POLICY_ALLOW',
      matched_rule_ids: ['a-allow', 'z-allow'],
    });
    expect(Object.isFrozen(result.matched_rule_ids)).toBe(true);
  });

  it.each([
    ['deny', 'allow', 'POLICY_DENY'],
    ['allow', 'deny', 'POLICY_ALLOW'],
  ])('uses higher %s precedence over lower %s', async (higher, lower, code) => {
    expect(
      await resolve([
        { ...engineerRule, rule_id: 'low', precedence: 400, effect: lower },
        { ...engineerRule, rule_id: 'high', precedence: 600, effect: higher },
      ]),
    ).toMatchObject({ code, matched_rule_ids: ['high'] });
  });

  it.each([
    ['action', { action_ids: ['other action'] }, 'AUTHORITY_ACTION_DENIED'],
    [
      'subject',
      { subjects: [{ kind: 'human', roles: ['inspector'] }] },
      'AUTHORITY_SUBJECT_DENIED',
    ],
    [
      'operation',
      { selector: { ...engineerRule.selector, operations: ['delete'] } },
      'AUTHORITY_OPERATION_DENIED',
    ],
    [
      'consent',
      { required_consent: { ...engineerRule.required_consent, experimental: true } },
      'AUTHORITY_CONSENT_REQUIRED',
    ],
  ])(
    'does not fall back to a lower rule after a higher %s refusal',
    async (_name, changed, code) => {
      expect(
        await resolve([
          engineerRule,
          { ...engineerRule, rule_id: 'high', precedence: 600, ...changed },
        ]),
      ).toMatchObject({ outcome: 'deny', code, matched_rule_ids: ['high'] });
    },
  );

  it('allows a fully classified rename with a deduplicated matching rule', async () => {
    expect(await resolve([engineerRule], renamed)).toMatchObject({
      code: 'POLICY_ALLOW',
      matched_rule_ids: [engineerRule.rule_id],
    });
  });

  it.each(['canonical_relative_path', 'rename_from_canonical_relative_path'])(
    'refuses an unclassified rename endpoint %s',
    async (field) => {
      expect(
        await resolve([engineerRule], { ...renamed, [field]: 'unknown/file.ts' }),
      ).toMatchObject({
        outcome: 'deny',
        code: 'UNCLASSIFIED_RESOURCE',
        matched_rule_ids: [],
      });
    },
  );

  it.each(['canonical_relative_path', 'rename_from_canonical_relative_path'])(
    'preserves Inspector precedence for protected rename endpoint %s',
    async (field) => {
      expect(
        await resolve([engineerRule, inspectorRule], {
          ...renamed,
          [field]: 'packages/core/src/test/protected.test.ts',
        }),
      ).toMatchObject({
        outcome: 'deny',
        code: 'AUTHORITY_SUBJECT_DENIED',
        matched_rule_ids: [inspectorRule.rule_id],
      });
    },
  );
});
