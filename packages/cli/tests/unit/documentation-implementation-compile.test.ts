// ADR-AUT-0009 compiler controls. Pure compilation is not authority admission.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentationProtectedClass } from '@devai-nyx/authority';
import { compileDocumentationImplementationRules } from '../../src/authority/policy-documentation-implementation.js';
import { classWriteVerbs } from '../../src/authority/policy-support.js';
import { canonicalRegistry } from '../../src/define-command.js';

const constitution = {
  version: '1.2.1',
  digest_sha256: '4dbb9caa8961cf3bbf8070faf7525711b018b1aaa3b47b17ae9a85f55cf4b57c',
};
const files = [
  'docs/site/docusaurus.config.js',
  'docs/site/scripts/generate-api-reference.mjs',
  'docs/site/scripts/run-lighthouse.mjs',
  'docs/site/scripts/sync-content.mjs',
  'docs/site/scripts/verify-api-reference.mjs',
];
const entries = canonicalRegistry();
function compile(block: unknown, identity = constitution) {
  return compileDocumentationImplementationRules({
    block,
    constitution: identity,
    repositoryId: 'inspector.docs',
    entries,
  });
}

describe('exact documentation compiler', () => {
  it('binds the genuine supported constitution bytes and registered Engineer verbs', () => {
    const bytes = readFileSync(resolve(import.meta.dirname, '../../../..', 'law/constitution.md'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(constitution.digest_sha256);
    const result = compile({ files: [...files].reverse() });
    expect(result).toBeDefined();
    if (!result) throw new Error('compiler unexpectedly absent');
    expect(result.files).toEqual(files);
    expect(result.rules).toHaveLength(5);
    expect(new Set(result.rules.map((r) => r.rule_id)).size).toBe(5);
    expect(classWriteVerbs(entries).root).toEqual(['source apply engineer', 'task start']);
    for (const [index, rule] of result.rules.entries()) {
      expect(rule).toMatchObject({
        origin: 'immutable-core',
        precedence: 700,
        action_ids: ['source apply engineer', 'task start'],
        effect: 'allow',
        selector: {
          kind: 'fs',
          repository_id: 'inspector.docs',
          canonical_relative_path_glob: files[index],
          operations: ['create', 'update', 'delete', 'rename'],
        },
        subjects: [
          { kind: 'human', roles: ['engineer'] },
          {
            kind: 'derived-machine',
            actor: 'harness',
            transition: 'harness-write',
            initiator: {
              allowed_roles: ['engineer'],
              preserve_in_context: true,
            },
          },
        ],
        required_consent: {
          write: true,
          allow_publish: false,
          experimental: false,
        },
        constitutional_anchors: [6, 7, 8, 9, 10],
      });
    }
  });

  it.each(['1.0.2', '1.1.0', '1.1.1', '1.1.2', '1.2.0', '1.2.2'])(
    'refuses version %s even with candidate digest',
    (version) => {
      expect(() => compile({ files }, { ...constitution, version })).toThrow(
        'DOCUMENTATION_IMPLEMENTATION_CONSTITUTION_UNSUPPORTED',
      );
    },
  );
  it('refuses exact version with a different digest', () => {
    expect(() => compile({ files }, { ...constitution, digest_sha256: '0'.repeat(64) })).toThrow(
      'DOCUMENTATION_IMPLEMENTATION_CONSTITUTION_UNSUPPORTED',
    );
  });
  it('leaves absent specialization untouched without consulting new inputs', () => {
    expect(
      compileDocumentationImplementationRules({
        block: undefined,
        get constitution(): never {
          throw new Error('unexpected constitution read');
        },
        get repositoryId(): never {
          throw new Error('unexpected repository read');
        },
        get entries(): never {
          throw new Error('unexpected registry read');
        },
      }),
    ).toBeUndefined();
  });
  it.each([
    'docs/test/probe.ts',
    'docs/probe.spec.ts',
    'docs/e2e/probe.js',
    'docs/vitest.config.ts',
    'docs/schemas/model.ts',
    'docs/architecture/plan.js',
    'docs/README.ts',
    'docs/site/../script.js',
    'docs//script.js',
    '/docs/script.js',
    'docs/*.js',
    'docs/site',
    'src/docs/script.js',
    'docs/guide.md',
  ])('refuses protected or noncanonical selection %s', (path) => {
    expect(() => compile({ files: [path] })).toThrow('DOCUMENTATION_IMPLEMENTATION_INVALID');
  });
  it('keeps protected test classification separate from legacy default-role agreement', () => {
    for (const path of [
      'docs/test/probe.ts',
      'docs/probe.spec.ts',
      'docs/e2e/probe.js',
      'docs/vitest.config.ts',
    ]) {
      expect(documentationProtectedClass(path)).toBe('test');
    }
  });
  it.each([null, [], {}, { files: [] }, { files: [files[0], files[0]] }, { files, extra: true }])(
    'refuses malformed closed block %#',
    (block) => {
      expect(() => compile(block)).toThrow('DOCUMENTATION_IMPLEMENTATION_INVALID');
    },
  );
  it('refuses selected files when no registered Engineer write verb exists', () => {
    expect(() =>
      compileDocumentationImplementationRules({
        block: { files },
        constitution,
        repositoryId: 'inspector.docs',
        entries: [],
      }),
    ).toThrow('registered Engineer write verbs unavailable');
  });
});
