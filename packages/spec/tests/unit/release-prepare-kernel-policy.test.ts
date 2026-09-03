import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../../schemas/src/index.js';

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
          certification_manifest: {
            entry_fields: string[];
            entry_origins: string[];
            entry_order: string;
            manifest_digest: string;
          };
          content_source: { git_object: string; generated_output: string; locator_rule: string };
          pack: {
            implementation: string;
            pack_spec_canonical_bytes: string;
            pack_spec_digest_sha256: string;
            pack_spec_id: string;
            outputs: string[];
            forbidden_execution: string[];
          };
          artifact_sink: { required: boolean; protocol: string[]; missing_sink: string };
          prepared_state: string;
          downstream_reverification: string;
          errors: string[];
        };
        state_semantic_kernel: { algorithm: string[] };
      };
    }>('law/policy/release-lifecycle.json');
    const policySchema = readJson<{
      examples: Array<{ execution_contract: { prepare_kernel: unknown } }>;
    }>('law/schemas/release-lifecycle-policy.schema.json');
    const common = readJson<Record<string, unknown>>('law/schemas/common-defs.schema.json');
    const recordMeta = readJson<Record<string, unknown>>('law/schemas/record-meta.schema.json');
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(common, 'common-defs.schema.json');
    ajv.addSchema(recordMeta, 'record-meta.schema.json');
    const validatePolicy = ajv.compile(policySchema);

    const kernel = policy.execution_contract.prepare_kernel;
    expect(validatePolicy(policy), JSON.stringify(validatePolicy.errors)).toBe(true);
    expect(policySchema.examples[0]?.execution_contract.prepare_kernel).toEqual(kernel);
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
    expect(kernel.certification_manifest).toMatchObject({
      entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
      manifest_digest:
        'sha256-of-domain-DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1-nul-followed-by-utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted',
    });
    expect(kernel.content_source.git_object).toContain(
      'blob-space-decimal-byte-length-nul-raw-bytes',
    );
    expect(kernel.content_source.locator_rule).toContain(
      'host-paths-symlinks-and-ambient-worktree-reads-are-forbidden',
    );
    expect(kernel.pack.implementation).toBe('pure-in-memory-npm-compatible-tar-gzip');
    expect(kernel.content_source.generated_output).toContain(
      'release-certification-evidence-receipt-v1',
    );
    expect(kernel.pack.pack_spec_id).toBe('devai.pure-npm-compatible-pack.v3');
    expect(kernel.pack.pack_spec_digest_sha256).toBe(
      'd287db048eb09efaea20c7e4d6b8b721d34e08eb05b6cbc7f19fba4c666917bd',
    );
    expect(createHash('sha256').update(kernel.pack.pack_spec_canonical_bytes).digest('hex')).toBe(
      kernel.pack.pack_spec_digest_sha256,
    );
    expect(kernel.pack.outputs).toEqual(['package-tarball', 'package-sbom', 'package-manifest']);
    expect(kernel.pack.pack_spec_canonical_bytes).toContain(
      'block-rule=greedy-consecutive-65535-byte-blocks-in-tar-order-plus-one-final-remainder-block',
    );
    expect(kernel.pack.pack_spec_canonical_bytes).toContain(
      'BFINAL=1-only-on-final-block;empty-tar-stream=one-zero-length-stored-block-with-BFINAL-1',
    );
    expect(kernel.pack.pack_spec_canonical_bytes).toContain(
      'creationInfo.creators=[Tool: devai.pure-npm-compatible-pack.v3];creationInfo.optionalFields=comment-licenseListVersion=absent;documentDescribes=[SPDXRef-Package];document.optionalFields=comment-externalDocumentRefs-annotations-hasExtractedLicensingInfos-revieweds-snippets=absent',
    );
    expect(kernel.pack.pack_spec_canonical_bytes).toContain(
      'package.packageVerificationCode.value=lowercase-hex(SHA1(utf8-concatenation-of-each-file-raw-byte-SHA1-lowercase-hex-sorted-ascending-lexicographically-by-checksum-value))',
    );
    expect(kernel.pack.pack_spec_canonical_bytes).toContain(
      'file.SPDXID=SPDXRef-File-<lowercase-sha256-of-utf8-archive-path>;file.fileName=archive-path;file.checksums=[SHA1:lowercase-raw-byte-sha1,SHA256:lowercase-entry.sha256]',
    );
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
    expect(kernel.prepared_state).toContain('schemaVersion-2.1.0');
    expect(kernel.downstream_reverification).toContain('exact-committed-manifest-handle');
    expect(kernel.errors).toEqual([
      'release-prepare-certification-manifest-invalid',
      'release-prepare-package-entry-coverage-invalid',
      'release-prepare-immutable-blob-locator-invalid',
      'release-prepare-content-digest-mismatch',
      'release-prepare-pack-spec-digest-mismatch',
      'release-prepare-unsupported-package-semantics',
      'release-prepare-subprocess-forbidden',
      'release-artifact-sink-unavailable',
      'release-artifact-sink-protocol-invalid',
      'release-artifact-sink-verification-failed',
      'release-artifact-sink-commit-failed',
      'release-artifact-sink-abort-failed',
      'release-downstream-artifact-reverification-failed',
    ]);
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

  it('accepts only opaque-handle v3 prepared artifacts and independent generated-output receipts', () => {
    const sha = (letter: string) => letter.repeat(64);
    const git = '0123456789012345678901234567890123456789';
    const artifact = (kind: string, value: string) => ({
      kind,
      sink_id: 'trusted-sink',
      opaque_handle: `artifact-${value}`,
      sha256: sha(value),
      size_bytes: 1,
    });
    const certificate = {
      candidate: { commit: git, tree: git },
      task_policy_digest_sha256: sha('a'),
      package_id: 'pkg',
      package_version: '1.0.0',
      entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
      manifest_digest_contract: {
        domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\u0000',
        payload:
          'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
        canonicalization: 'rfc8785-jcs',
        algorithm: 'sha256',
      },
      entries: [
        {
          path: 'generated.js',
          mode: '100644',
          size_bytes: 1,
          sha256: sha('b'),
          immutable_blob_locator: {
            kind: 'generated-output',
            output_blob_sha256: sha('b'),
            certification_evidence_receipt: {
              kind: 'release-certification-evidence-receipt-v1',
              receipt_digest_sha256: sha('c'),
              canonicalization: 'utf-8-rfc8785-jcs-sha256',
              referent: {
                candidate_commit: git,
                candidate_tree: git,
                task_policy_digest_sha256: sha('a'),
                package_id: 'pkg',
                output_blob_sha256: sha('b'),
              },
            },
          },
        },
      ],
      manifest_digest_sha256: sha('d'),
    };
    const state: unknown = {
      schemaVersion: '2.1.0',
      state_id: 'RLS-0123456789abcdef',
      state: 'prepared',
      action_id: 'release prepare',
      effect: 'local-write',
      prior_state: {
        state: 'certified',
        state_id: 'RLS-fedcba9876543210',
        record_digest_sha256: sha('e'),
      },
      bound_receipts: [],
      repository: { id: 'devai', commit: git, tree: git },
      candidate: { release_unit: 'unit', version: '1.0.0', commit: git, tree: git },
      inputs: [{ kind: 'task-policy', path: 'law/policy/task.json', sha256: sha('a') }],
      evidence: {
        manifest_digest_sha256: sha('d'),
        receipt_digests: [],
        independently_checkable: true,
      },
      artifacts: [
        artifact('package-manifest', 'f'),
        artifact('package-tarball', '1'),
        artifact('package-sbom', '2'),
      ],
      artifact_sink: {
        sink_id: 'trusted-sink',
        transaction_handle: 'transaction-1',
        committed_manifest_handle: 'manifest-1',
        committed_manifest_sha256: sha('f'),
        committed_manifest_size_bytes: 1,
        commit_protocol: 'devai.artifact-sink.two-phase.v1',
      },
      actor: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
      consent: { write: true, allow_publish: false, experimental: false },
      authorization_event_id: null,
      publication_expectation: null,
      canonicalization: {
        kernel_id: 'devai.kernel.release-lifecycle-state.v2',
        encoding: 'utf-8',
        json_form: 'rfc8785-jcs',
        digest_algorithm: 'sha256',
        projection_excludes: ['state_id', 'record_digest_sha256'],
        id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
      },
      release_units: [
        {
          release_unit: 'unit',
          version: '1.0.0',
          packages: [
            {
              package_id: 'pkg',
              package_manifest: artifact('package-manifest', 'f'),
              package_tarball: artifact('package-tarball', '1'),
              package_sbom: artifact('package-sbom', '2'),
              evidence_manifest: null,
              provider_result: null,
              trust: null,
              certification_manifest: certificate,
            },
          ],
        },
      ],
      storage: { generation: 1, head_before: { generation: 0, record_digest_sha256: sha('e') } },
      recorded_at: '2026-09-03T00:00:00Z',
      record_digest_sha256: sha('f'),
    };
    const validate = getValidator('release-lifecycle-state.schema.json');

    expect(validate(state), JSON.stringify(validate.errors)).toBe(true);
    const pathnameBypass = structuredClone(state) as { artifacts: Array<Record<string, unknown>> };
    pathnameBypass.artifacts[0] = {
      kind: 'package-manifest',
      path: 'release/manifest.json',
      sha256: sha('f'),
      size_bytes: 1,
    };
    expect(validate(pathnameBypass)).toBe(false);
    const circularReceipt = structuredClone(state) as {
      release_units: Array<{
        packages: Array<{
          certification_manifest: {
            entries: Array<{ immutable_blob_locator: Record<string, unknown> }>;
          };
        }>;
      }>;
    };
    circularReceipt.release_units[0]!.packages[0]!.certification_manifest.entries[0]!.immutable_blob_locator.certification_evidence_receipt =
      {
        kind: 'release-certification-evidence-receipt-v1',
        receipt_digest_sha256: sha('c'),
        canonicalization: 'utf-8-rfc8785-jcs-sha256',
        referent: { candidate_commit: git },
      };
    expect(validate(circularReceipt)).toBe(false);
  });
});
