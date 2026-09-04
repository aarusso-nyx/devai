import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
  readCertifiedEvidenceCarrier,
} from '../../src/services/release-certified-evidence-carrier.js';

const INVALID = 'release-certified-evidence-carrier-invalid';
const MAXIMUM = 1_048_576;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

const taskPolicy = {
  schemaVersion: '1.2.0',
  tasks: [
    { nodeId: 'format', taskKey: 'format@1' },
    { nodeId: 'lint', taskKey: 'lint@1' },
  ],
};

function result(nodeId: string, taskKey: string) {
  return {
    schemaVersion: '1.0.0' as const,
    nodeId,
    taskKey,
    status: 'PASS' as const,
    inputDigest: digest({ nodeId }),
    dependencyResultDigests: {},
    outputDigests: {},
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:01.000Z',
  };
}

const results = [result('format', 'format@1'), result('lint', 'lint@1')];

const derivation = {
  repository: { id: 'devai', commit: COMMIT, tree: TREE },
  candidate: { commit: COMMIT, tree: TREE },
  task_policy_digest_sha256: digest(taskPolicy),
};

const receipt = {
  schemaVersion: '1.1.0',
  repository: { id: 'devai', commit: COMMIT, tree: TREE },
  profile: 'rc',
  taskPolicyDigest: digest(taskPolicy),
  createdAt: '2026-09-04T00:00:02.000Z',
  tasks: results.map((value) => ({
    nodeId: value.nodeId,
    taskKey: value.taskKey,
    resultDigest: digest(value),
  })),
};

const census = finalizeCertifiedEvidenceNamespaceCensus({
  release_unit: '@aarusso-nyx/devai',
  derivation,
  entries: [
    {
      path: 'packages/cli/dist/b.js',
      mode: '100644',
      sha256: 'c'.repeat(64),
      size_bytes: 12,
      task_node: 'build',
    },
    {
      path: 'packages/cli/dist/a.js',
      mode: '100644',
      sha256: 'd'.repeat(64),
      size_bytes: 7,
      task_node: 'build',
    },
  ],
});

function build(overrides: Record<string, unknown> = {}) {
  return createCertifiedEvidenceCarrier({
    release_unit: '@aarusso-nyx/devai',
    derivation,
    candidate_receipt: receipt,
    task_policy: taskPolicy,
    task_results: results,
    namespace_census: census,
    maximum_bytes: MAXIMUM,
    ...overrides,
  });
}

describe('release certified evidence carrier', () => {
  it('round-trips the complete population regardless of caller result order', () => {
    const forward = build();
    const reversed = build({ task_results: [...results].reverse() });
    expect(reversed.equals(forward)).toBe(true);

    const read = readCertifiedEvidenceCarrier(forward, MAXIMUM);
    expect(read.carrier.release_unit).toBe('@aarusso-nyx/devai');
    expect(read.task_results).toHaveLength(2);
    expect(JSON.parse(read.candidate_receipt.toString('utf8'))).toEqual(receipt);
    expect(JSON.parse(read.task_policy.toString('utf8'))).toEqual(taskPolicy);
    expect(
      read.task_results
        .map((value) => JSON.parse(value.toString('utf8')) as { nodeId: string })
        .map((value) => value.nodeId)
        .sort(),
    ).toEqual(['format', 'lint']);
    expect(read.derivation_binding_digest_sha256).toBe(digest(derivation));
  });

  it('emits a sorted digest-only census bound to the protected derivation', () => {
    const read = readCertifiedEvidenceCarrier(build(), MAXIMUM);
    expect(read.census.entries.map((entry) => entry.path)).toEqual([
      'packages/cli/dist/a.js',
      'packages/cli/dist/b.js',
    ]);
    expect(read.census.derivation).toEqual(derivation);
    expect(read.namespace_census.toString('utf8')).not.toContain('stdout');
  });

  it('refuses a result population that does not match the candidate receipt', () => {
    expect(() => build({ task_results: [results[0]] })).toThrow(INVALID);
    expect(() => build({ task_results: [...results, result('extra', 'extra@1')] })).toThrow(
      INVALID,
    );
    expect(() => build({ task_results: [results[0], results[0]] })).toThrow(INVALID);
    expect(() =>
      build({
        task_results: [results[0], { ...results[1], finishedAt: '2026-09-04T00:00:09.000Z' }],
      }),
    ).toThrow(INVALID);
  });

  it('refuses a policy or receipt that is not bound to the derivation', () => {
    expect(() => build({ task_policy: { ...taskPolicy, schemaVersion: '1.1.0' } })).toThrow(
      INVALID,
    );
    expect(() =>
      build({ candidate_receipt: { ...receipt, taskPolicyDigest: 'e'.repeat(64) } }),
    ).toThrow(INVALID);
    expect(() =>
      build({
        candidate_receipt: { ...receipt, repository: { id: 'other', commit: COMMIT, tree: TREE } },
      }),
    ).toThrow(INVALID);
  });

  it('refuses invalid derivation bindings', () => {
    expect(() =>
      build({ derivation: { ...derivation, candidate: { commit: COMMIT, tree: 'f'.repeat(64) } } }),
    ).toThrow(INVALID);
    expect(() =>
      build({
        derivation: {
          ...derivation,
          repository: { id: 'devai', commit: 'f'.repeat(40), tree: TREE },
        },
      }),
    ).toThrow(INVALID);
  });

  it('refuses census members carrying raw stream or generated bytes', () => {
    const carrier = JSON.parse(build().toString('utf8')) as Record<string, unknown>;
    const smuggled = {
      ...census,
      entries: census.entries.map((entry) => ({ ...entry, stdout: 'x' })),
    };
    const bytes = Buffer.from(canonicalJson(smuggled), 'utf8');
    carrier.namespace_census = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size_bytes: bytes.length,
      bytes_base64: bytes.toString('base64'),
    };
    expect(() =>
      readCertifiedEvidenceCarrier(Buffer.from(canonicalJson(carrier), 'utf8'), MAXIMUM),
    ).toThrow(INVALID);
  });

  it('refuses a census bound to a different derivation or unit', () => {
    const carrier = JSON.parse(build().toString('utf8')) as Record<string, unknown>;
    const foreign = finalizeCertifiedEvidenceNamespaceCensus({
      release_unit: '@aarusso-nyx/devai',
      derivation: { ...derivation, task_policy_digest_sha256: 'a'.repeat(64) },
      entries: census.entries,
    });
    const bytes = Buffer.from(canonicalJson(foreign), 'utf8');
    carrier.namespace_census = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size_bytes: bytes.length,
      bytes_base64: bytes.toString('base64'),
    };
    expect(() =>
      readCertifiedEvidenceCarrier(Buffer.from(canonicalJson(carrier), 'utf8'), MAXIMUM),
    ).toThrow(INVALID);
  });

  it('refuses tampered, unsorted, extra, and non-canonical carrier members', () => {
    const carrier = JSON.parse(build().toString('utf8')) as Record<string, unknown>;
    expect(() =>
      readCertifiedEvidenceCarrier(
        Buffer.from(canonicalJson({ ...carrier, extra: 1 }), 'utf8'),
        MAXIMUM,
      ),
    ).toThrow(INVALID);

    const unsorted = {
      ...carrier,
      task_results: [...(carrier.task_results as unknown[])].reverse(),
    };
    expect(() =>
      readCertifiedEvidenceCarrier(Buffer.from(canonicalJson(unsorted), 'utf8'), MAXIMUM),
    ).toThrow(INVALID);

    expect(() =>
      readCertifiedEvidenceCarrier(Buffer.from(`${canonicalJson(carrier)} `, 'utf8'), MAXIMUM),
    ).toThrow(INVALID);

    const tampered = JSON.parse(JSON.stringify(carrier)) as {
      candidate_receipt: { bytes_base64: string };
    };
    tampered.candidate_receipt.bytes_base64 = Buffer.from(
      canonicalJson({ ...receipt, profile: 'affected' }),
      'utf8',
    ).toString('base64');
    expect(() =>
      readCertifiedEvidenceCarrier(Buffer.from(canonicalJson(tampered), 'utf8'), MAXIMUM),
    ).toThrow(INVALID);
  });

  it('validates reader and writer bounds', () => {
    const bytes = build();
    expect(() => readCertifiedEvidenceCarrier(bytes, 0)).toThrow(INVALID);
    expect(() => readCertifiedEvidenceCarrier(bytes, 1.5)).toThrow(INVALID);
    expect(() => readCertifiedEvidenceCarrier(bytes, bytes.length - 1)).toThrow(INVALID);
    expect(() => build({ maximum_bytes: 0 })).toThrow(INVALID);
    expect(() => build({ maximum_bytes: Number.NaN })).toThrow(INVALID);
    expect(() => build({ maximum_bytes: 64 })).toThrow(INVALID);
    expect(readCertifiedEvidenceCarrier(bytes, bytes.length).carrier.kind).toBe(
      'devai.release-certified-evidence-carrier-json.v1',
    );
  });
});
