import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import {
  jsonBytes,
  resolveAdopterPolicyMaterialization,
} from '../../src/services/adopter-policy.js';
import {
  parseAdopterPolicyBinding,
  verifyAdopterPolicyBindingSnapshot,
} from '../../src/services/adopter-policy-binding.js';

const DIGEST = 'a'.repeat(64);
const FRAMEWORK_VERSION = '1.4.5';
const SOURCE_PATH = 'law/policy/adopter-policy.json';
const BINDING_PATH = '.devai/config/adopter-policy-binding.json';

function historicalBinding() {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'devai-adopter-policy',
    policy_version: '1.4.5',
    source_path: 'law/policy/devai-adoption.json',
    source_digest_sha256: DIGEST,
    materialized: {
      '.devai/config/project.json': DIGEST,
      '.devai/config/thresholds.json': 'b'.repeat(64),
    },
  } as const;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const policy = {
  schemaVersion: '1.0.0',
  policy_id: 'fixture.adopter-policy',
  policy_version: '1.0.0',
  release_verification: {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.release-profile',
    policy_version: '1.0.0',
    release_unit: '@fixture/package',
    version_source: 'package.json',
    default_support: 'current',
    capability_tasks: { lint: ['lint'] },
    risk_capabilities: {},
    mutation_roster: [],
  },
} as const;

const project = {
  schemaVersion: '1.0.0',
  project_type: 'framework',
} as const;

function materialize(input: {
  readonly policy: unknown;
  readonly currentProject: unknown;
  readonly frameworkVersion: string;
}): ReadonlyMap<string, string> {
  return resolveAdopterPolicyMaterialization(input);
}

function snapshot(
  options: {
    readonly policy?: Readonly<Record<string, unknown>>;
    readonly project?: Readonly<Record<string, unknown>>;
    readonly frameworkVersion?: string;
  } = {},
) {
  const policyDocument = options.policy ?? policy;
  const projectDocument = options.project ?? project;
  const frameworkVersion = options.frameworkVersion ?? FRAMEWORK_VERSION;
  const source = Buffer.from(jsonBytes(policyDocument), 'utf8');
  const materialized = materialize({
    policy: policyDocument,
    currentProject: projectDocument,
    frameworkVersion,
  });
  const files = new Map<string, Uint8Array>([
    [SOURCE_PATH, source],
    ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes, 'utf8')] as const),
  ]);
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: policyDocument['policy_id'],
    policy_version: policyDocument['policy_version'],
    source_path: SOURCE_PATH,
    source_digest_sha256: sha256(source),
    materialized: Object.fromEntries(
      [...materialized].map(([path, bytes]) => [path, sha256(Buffer.from(bytes, 'utf8'))]),
    ),
  };
  files.set(BINDING_PATH, Buffer.from(jsonBytes(binding), 'utf8'));
  return { binding, files, frameworkVersion, materialized, policyDocument, projectDocument };
}

function verify(
  fixture: ReturnType<typeof snapshot>,
  overrides: Partial<Parameters<typeof verifyAdopterPolicyBindingSnapshot>[0]> = {},
) {
  return verifyAdopterPolicyBindingSnapshot({
    files: fixture.files,
    frameworkVersion: fixture.frameworkVersion,
    validatePolicy: (document) => getValidator('adopter-policy.schema.json')(document),
    validateProject: (document) => getValidator('project-config.schema.json')(document),
    materialize,
    ...overrides,
  });
}

function expectBindingRefusal(run: () => unknown): void {
  try {
    run();
    expect.unreachable('binding verifier must refuse');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('rpl-adopter-binding-mismatch');
  }
}

describe('adopter policy binding parser', () => {
  it('preserves a valid historical v1 binding without selecting or reading files', () => {
    const binding = historicalBinding();

    expect(parseAdopterPolicyBinding(JSON.stringify(binding))).toEqual({ binding });
  });

  it.each([
    ['malformed JSON', '{', 'BINDING_MALFORMED'],
    ['a non-object JSON value', '[]', 'BINDING_MALFORMED'],
    [
      'an unsupported schema version',
      JSON.stringify({ ...historicalBinding(), schemaVersion: '2.0.0' }),
      'BINDING_VERSION_UNSUPPORTED',
    ],
    [
      'a malformed source digest',
      JSON.stringify({ ...historicalBinding(), source_digest_sha256: 'not-a-sha256' }),
      'BINDING_MALFORMED',
    ],
    [
      'a non-map materialized value',
      JSON.stringify({ ...historicalBinding(), materialized: [] }),
      'BINDING_MALFORMED',
    ],
    [
      'a malformed materialized digest',
      JSON.stringify({
        ...historicalBinding(),
        materialized: { '.devai/config/project.json': 'not-a-sha256' },
      }),
      'BINDING_MALFORMED',
    ],
  ])('%s is refused as %s', (_label, bytes, reason) => {
    expect(parseAdopterPolicyBinding(bytes)).toEqual({ reason });
  });

  it('refuses extra or missing root keys under the closed v1 receipt keyset', () => {
    const binding = historicalBinding();
    const missing = { ...binding } as { source_path?: string } & Omit<
      typeof binding,
      'source_path'
    >;
    delete missing.source_path;

    expect(parseAdopterPolicyBinding(JSON.stringify({ ...binding, extra: true }))).toEqual({
      reason: 'BINDING_MALFORMED',
    });
    expect(parseAdopterPolicyBinding(JSON.stringify(missing))).toEqual({
      reason: 'BINDING_MALFORMED',
    });
  });

  it('verifies exact raw materialization bytes using the installed validators and materializer', () => {
    const fixture = snapshot();

    expect(verify(fixture)).toMatchObject({
      policy,
      project: { ...project, devai_version: FRAMEWORK_VERSION },
      release_verification: policy.release_verification,
      adopter_policy: { path: SOURCE_PATH, sha256: sha256(fixture.files.get(SOURCE_PATH) ?? []) },
      binding_receipt: { path: BINDING_PATH },
    });
  });

  it('rejects raw source or materialized-output drift even when the parsed JSON has equal JCS', () => {
    const sourceDrift = snapshot();
    sourceDrift.files.set(SOURCE_PATH, Buffer.from(JSON.stringify(policy), 'utf8'));
    expectBindingRefusal(() => verify(sourceDrift));

    const outputDrift = snapshot();
    const projectPath = '.devai/config/project.json';
    const originalProject = outputDrift.files.get(projectPath);
    if (originalProject === undefined)
      throw new Error('fixture project materialization is missing');
    outputDrift.files.set(
      projectPath,
      Buffer.from(JSON.stringify(JSON.parse(originalProject.toString()))),
    );
    expectBindingRefusal(() => verify(outputDrift));
  });

  it('rejects incomplete or extra materialized target bindings', () => {
    const incomplete = snapshot();
    const missing = { ...incomplete.binding.materialized };
    delete missing['.devai/config/domains.json'];
    incomplete.files.set(
      BINDING_PATH,
      Buffer.from(jsonBytes({ ...incomplete.binding, materialized: missing }), 'utf8'),
    );
    expectBindingRefusal(() => verify(incomplete));

    const extra = snapshot();
    extra.files.set(
      BINDING_PATH,
      Buffer.from(
        jsonBytes({
          ...extra.binding,
          materialized: { ...extra.binding.materialized, '.devai/config/extra.json': DIGEST },
        }),
        'utf8',
      ),
    );
    expectBindingRefusal(() => verify(extra));
  });

  it('rejects traversal, missing explicit release profile, framework mismatch, and false validators', () => {
    const traversal = snapshot();
    traversal.files.set(
      BINDING_PATH,
      Buffer.from(
        jsonBytes({ ...traversal.binding, source_path: 'law/policy/../adopter-policy.json' }),
        'utf8',
      ),
    );
    expectBindingRefusal(() => verify(traversal));

    const withoutProfile = snapshot({
      policy: { ...policy, release_verification: undefined },
    });
    expectBindingRefusal(() => verify(withoutProfile));

    const versionMismatch = snapshot();
    expectBindingRefusal(() => verify(versionMismatch, { frameworkVersion: '1.4.6' }));

    const invalidPolicy = snapshot();
    expectBindingRefusal(() => verify(invalidPolicy, { validatePolicy: () => false }));

    const invalidProject = snapshot();
    expectBindingRefusal(() => verify(invalidProject, { validateProject: () => false }));
  });

  it('rejects a materializer that cannot reproduce the bound project bytes', () => {
    const fixture = snapshot();
    expectBindingRefusal(() =>
      verify(fixture, {
        materialize: (input) => {
          const resolved = new Map(materialize(input));
          resolved.set(
            '.devai/config/project.json',
            `${resolved.get('.devai/config/project.json')} `,
          );
          return resolved;
        },
      }),
    );
  });
});
