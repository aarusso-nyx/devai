import { validators } from '@devai-nyx/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSENT,
  REPOSITORY_ID,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  engineerRule,
  expectSuccess,
  fsTarget,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Rename classification contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant id 8381 in
// runtime/policy-resolver.ts. A rename names two paths; policy classification must cover
// both, so a selector reaching only the destination classifies nothing.

type AnyRecord = Record<string, unknown>;
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

const renameResource = {
  kind: 'fs',
  id: 'fs:packages/core/src/renamed.ts',
  repository_id: REPOSITORY_ID,
  canonical_relative_path: 'packages/core/src/renamed.ts',
  operation: 'rename',
  rename_from_canonical_relative_path: fsTarget.canonical_relative_path,
};

const renameRule = (glob: string) => ({
  ...engineerRule,
  rule_id: `rename-${canonicalSha256(glob).slice(0, 16)}`,
  selector: {
    kind: 'fs',
    repository_id: REPOSITORY_ID,
    canonical_relative_path_glob: glob,
    operations: ['rename'],
  },
});

async function resolveRename(rules: readonly unknown[]) {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  disposers.push(() => {
    issuer.dispose();
  });
  const plant = makePolicyPlant({ additiveRules: rules });
  expect(
    validators.authorityPolicy(plant.document),
    JSON.stringify(validators.authorityPolicy.errors),
  ).toBe(true);
  const policy = expectSuccess<{ provenance: unknown }>(
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
      declarationDependencies(issuer, actionDocument(), undefined, policy.provenance),
    ),
  );
  return api.resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: declaration.context_receipt,
      consent: CONSENT,
      resource: renameResource,
      operation: 'rename',
    },
    { receiptStore: issuer, canonicalSha256 },
  ) as AnyRecord;
}

describe('rename classification covers both endpoints', () => {
  it('allows a rename whose source and destination both fall under the selector', async () => {
    expect(await resolveRename([renameRule('packages/core/src/**')])).toMatchObject({
      outcome: 'allow',
      matched_rule_ids: [renameRule('packages/core/src/**').rule_id],
    });
  });

  it('classifies nothing when only the destination falls under a selector', async () => {
    expect(await resolveRename([renameRule('packages/core/src/renamed.ts')])).toMatchObject({
      outcome: 'deny',
      code: 'UNCLASSIFIED_RESOURCE',
    });
  });

  it('classifies nothing when only the source falls under a selector', async () => {
    expect(await resolveRename([renameRule(fsTarget.canonical_relative_path)])).toMatchObject({
      outcome: 'deny',
      code: 'UNCLASSIFIED_RESOURCE',
    });
  });

  it('classifies a rename under two selectors that cover one endpoint each', async () => {
    expect(
      await resolveRename([
        renameRule('packages/core/src/renamed.ts'),
        renameRule(fsTarget.canonical_relative_path),
      ]),
    ).toMatchObject({ outcome: 'allow' });
  });
});
