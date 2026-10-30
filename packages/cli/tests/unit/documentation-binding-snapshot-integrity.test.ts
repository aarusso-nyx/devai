import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import { verifyAdopterPolicyBindingSnapshot } from '../../src/services/adopter-policy-binding.js';
import { resolveAdopterPolicyMaterialization } from '../../src/services/adopter-policy.js';
import { registeredDocumentationRepository } from '../../../../tests/helpers/registered-documentation-git-fixture.js';

type Json = Record<string, unknown>;
function object(value: unknown): asserts value is Json {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function parsed(bytes: Uint8Array): Json {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  object(value);
  return value;
}
const POLICY = '.devai/config/authority-policy.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const profile = {
  schemaVersion: '1.0.0',
  policy_id: 'fixture.release-profile',
  policy_version: '1.0.0',
  release_unit: '@fixture/package',
  version_source: 'package.json',
  default_support: 'current',
  capability_tasks: { lint: ['lint'] },
  risk_capabilities: {},
  mutation_roster: [],
};
let repository: ReturnType<typeof registeredDocumentationRepository>;
let original: ReadonlyMap<string, Uint8Array>;
let defaults: unknown;
const packagePolicies = new Map<string, string>();
beforeAll(() => {
  repository = registeredDocumentationRepository();
  const policyRoot = resolve(import.meta.dirname, '../../dist/law/policy');
  function capture(directory: string, prefix = ''): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) capture(join(directory, entry.name), name + '/');
      else if (entry.isFile() && entry.name.endsWith('.json'))
        packagePolicies.set(name, readFileSync(join(directory, entry.name), 'utf8'));
    }
  }
  capture(policyRoot);

  repository.bind(undefined, false, {
    release_verification: profile,
  });
  const receipt = parsed(readFileSync(join(repository.cwd, BINDING)));
  object(receipt.materialized);
  original = new Map(
    [
      BINDING,
      POLICY,
      '.devai/pin/constitution.md',
      repository.sourcePath,
      ...Object.keys(receipt.materialized),
    ].map((path) => [path, readFileSync(join(repository.cwd, path))]),
  );
  defaults = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../law/policy/adopter-defaults/path-authority-classes.json',
      ),
      'utf8',
    ),
  );
});
afterAll(() => repository?.close());
function verify(files: ReadonlyMap<string, Uint8Array>) {
  return verifyAdopterPolicyBindingSnapshot({
    files,
    frameworkVersion: repository.executableBinding.packageVersion,
    authorityDefaults: defaults,
    validatePolicy: (document) => getValidator('adopter-policy.schema.json')(document) === true,
    validateProject: (document) => getValidator('project-config.schema.json')(document) === true,
    materialize: (input) =>
      resolveAdopterPolicyMaterialization(input, {
        getValidator,
        readPolicy: (file) =>
          packagePolicies.get(file) ?? assert.fail(`package policy missing: ${file}`),
      }),
  });
}
function rules(document: Json): Json[] {
  assert(Array.isArray(document.rules));
  return document.rules.map((row: unknown) => {
    object(row);
    return row;
  });
}
describe('complete offline documentation authority policy verification', () => {
  it('accepts an unchanged genuine registered binding and its complete default rules', () => {
    expect(verify(original).release_verification).toEqual(profile);
  });
  it('refuses a project-only materialized receipt despite unchanged candidate files', () => {
    const files = new Map(original);
    const receipt = parsed(files.get(BINDING) ?? assert.fail('binding absent'));
    object(receipt.materialized);
    receipt.materialized = {
      '.devai/config/project.json': receipt.materialized['.devai/config/project.json'],
    };
    files.set(BINDING, Buffer.from(JSON.stringify(receipt)));
    expect(() => verify(files)).toThrow('rpl-adopter-binding-mismatch');
    expect(verify(original).release_verification).toEqual(profile);
  });
  it('refuses a pending registered binding journal without changing policy or receipt bytes', () => {
    const files = new Map(original);
    files.set('.devai/config/adopter-policy-binding.journal.json', Buffer.from('{}'));
    expect(() => verify(files)).toThrow('rpl-adopter-binding-mismatch');
    expect(verify(original).release_verification).toEqual(profile);
  });
  it.each<[string, (document: Json) => void]>([
    [
      'all non-documentation rules removed',
      (document) => {
        document.rules = rules(document).filter((row) =>
          String(row.rule_id).startsWith('core-documentation-implementation-'),
        );
      },
    ],
    [
      'unrelated core rule altered',
      (document) => {
        const row = rules(document).find(
          (row) => !String(row.rule_id).startsWith('core-documentation-implementation-'),
        );
        assert(row);
        row.rationale = 'tampered unrelated core rule';
      },
    ],
    [
      'schema-invalid extra field',
      (document) => {
        document.unrecognized = true;
      },
    ],
    [
      'source digest altered',
      (document) => {
        object(document.source_policy);
        document.source_policy.digest_sha256 = 'a'.repeat(64);
      },
    ],
    [
      'resolved digest altered',
      (document) => {
        document.resolved_digest_sha256 = 'a'.repeat(64);
      },
    ],
    [
      'extension digest altered',
      (document) => {
        assert(Array.isArray(document.additive_extensions));
        const first: unknown = document.additive_extensions[0];
        object(first);
        first.digest_sha256 = 'a'.repeat(64);
      },
    ],
    [
      'expired enforcement shadow',
      (document) => {
        document.materialized_at = '1999-01-01T00:00:00.000Z';
        document.enforcement = {
          mode: 'shadow',
          shadow: {
            reason: 'expired test snapshot',
            approved_by: { role: 'architect', declaration_source: 'cli-flag' },
            expires_at: '2000-01-01T00:00:00.000Z',
          },
        };
      },
    ],
    [
      'future materialization',
      (document) => {
        document.materialized_at = '2999-01-01T00:00:00.000Z';
      },
    ],
  ])('refuses %s while the documentation subset and receipt remain unchanged', (_name, mutate) => {
    const files = new Map(original);
    const before = parsed(files.get(POLICY) ?? assert.fail('policy missing'));
    const selected = rules(before).filter((row) =>
      String(row.rule_id).startsWith('core-documentation-implementation-'),
    );
    const selectedBytes = JSON.stringify(selected);
    mutate(before);
    expect(
      JSON.stringify(
        rules(before).filter((row) =>
          String(row.rule_id).startsWith('core-documentation-implementation-'),
        ),
      ),
    ).toBe(selectedBytes);
    files.set(POLICY, Buffer.from(JSON.stringify(before)));
    expect(files.get(BINDING)).toBe(original.get(BINDING));
    expect(() => verify(files)).toThrow('rpl-adopter-binding-mismatch');
    expect(verify(original).release_verification).toEqual(profile);
  });
});
