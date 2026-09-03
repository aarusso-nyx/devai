import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
}

describe('release prepare v3 policy', () => {
  it('freezes pure in-memory packing, complete certification entries, and the sink transaction', () => {
    const policy = readJson<{
      execution_contract: {
        prepare_kernel: {
          kernel_id: string;
          stock_composition: { built_in_actions: string[]; prepare: string };
          certification_manifest: { entry_fields: string[]; entry_origins: string[] };
          content_source: { git_object: string; locator_rule: string };
          pack: {
            implementation: string;
            pack_spec_canonical_bytes: string;
            pack_spec_digest_sha256: string;
            outputs: string[];
            forbidden_execution: string[];
          };
          artifact_sink: { required: boolean; protocol: string[]; missing_sink: string };
          downstream_reverification: string;
        };
        state_semantic_kernel: { algorithm: string[] };
      };
    }>('law/policy/release-lifecycle.json');

    const kernel = policy.execution_contract.prepare_kernel;
    expect(kernel.kernel_id).toBe('devai.kernel.release-prepare.v3');
    expect(kernel.stock_composition).toEqual({
      built_in_actions: ['release plan', 'release preflight', 'release certify', 'release resume'],
      prepare: 'requires-injected-trusted-artifact-sink-and-has-no-stock-pathname-sink',
    });
    expect(kernel.certification_manifest.entry_fields).toEqual([
      'path',
      'mode',
      'size_bytes',
      'sha256',
      'immutable_blob_locator',
    ]);
    expect(kernel.certification_manifest.entry_origins).toEqual(['git-object', 'generated-output']);
    expect(kernel.content_source.git_object).toContain(
      'blob-space-decimal-byte-length-nul-raw-bytes',
    );
    expect(kernel.content_source.locator_rule).toContain(
      'host-paths-symlinks-and-ambient-worktree-reads-are-forbidden',
    );
    expect(kernel.pack.implementation).toBe('pure-in-memory-npm-compatible-tar-gzip');
    expect(kernel.pack.pack_spec_digest_sha256).toBe(
      'cc6b8ecd03c470a658b4a6f40c9adca37158d05700f69d780b9e12e12a6b092b',
    );
    expect(createHash('sha256').update(kernel.pack.pack_spec_canonical_bytes).digest('hex')).toBe(
      kernel.pack.pack_spec_digest_sha256,
    );
    expect(kernel.pack.outputs).toEqual(['package-tarball', 'sbom', 'manifest']);
    expect(kernel.pack.forbidden_execution).toEqual([
      'npm-subprocess',
      'tool-subprocess',
      'shell',
      'ambient-path-resolution',
    ]);
    expect(kernel.artifact_sink.required).toBe(true);
    expect(kernel.artifact_sink.missing_sink).toBe('fail-before-package-generation-or-exposure');
    expect(kernel.artifact_sink.protocol).toEqual([
      'begin-transaction-and-receive-opaque-transaction-handle',
      'put-verified-in-memory-artifacts-and-receive-opaque-artifact-handles',
      'sink-verifies-each-artifact-byte-digest-size-and-pack-spec-binding',
      'core-reverifies-the-sink-reported-handles-and-digests',
      'commit-one-complete-manifest-atomically-once',
      'abort-the-open-transaction-on-every-pre-commit-failure',
    ]);
    expect(kernel.downstream_reverification).toContain('only-through-opaque-sink-handles');
    expect(policy.execution_contract.state_semantic_kernel.algorithm).toContain(
      'require-release-certify-to-emit-one-complete-candidate-tree-task-policy-bound-package-entry-manifest-per-package-before-a-v3-prepare',
    );
  });

  it('does not permit a prepare caller to select a destination or a process capability', () => {
    const request = readJson<{
      allOf: Array<{ if?: { properties?: { action_id?: { const?: string } } }; then?: unknown }>;
    }>('law/schemas/release-lifecycle-request.schema.json');
    const registry = readJson<{
      entries: Array<{ action_id: string; authority_contract: { capabilities: string[] } }>;
    }>('law/policy/action-registry.json');
    const prepare = request.allOf.find(
      (branch) => branch.if?.properties?.action_id?.const === 'release prepare',
    );
    const action = registry.entries.find((entry) => entry.action_id === 'release prepare');

    expect(prepare?.then).toEqual({
      required: ['receipt_locators'],
      not: { anyOf: [{ required: ['provider'] }, { required: ['destination'] }] },
    });
    expect(action?.authority_contract.capabilities).toEqual([
      'fs:f5-state',
      'fs:proofs',
      'artifact-sink:write',
    ]);
  });
});
