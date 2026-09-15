import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface VerifierPolicy {
  package?: { name?: string; version?: string };
  authentication?: { secret?: string; github_token_fallback?: boolean };
  workflow_permissions?: { contents?: string; packages?: string; checks?: string };
  verifier?: {
    root?: string;
    provenance_sha256?: string;
    source_commit?: string;
    payload_file_count?: number;
    binaries?: Record<string, string>;
  };
  external_duplicate?: { name?: string; required?: boolean; sole_trust_root?: boolean };
  adopter_fallbacks?: unknown[];
}

type AuthorityModule = typeof import('@devai-nyx/authority');

const policyPath = resolve('law/policy/trusted-local-rc-verifier-package.json');
const canonicalPolicy = JSON.parse(readFileSync(policyPath, 'utf8')) as VerifierPolicy;

async function importScaffoldWithPolicy(policy: VerifierPolicy) {
  vi.resetModules();
  vi.doMock('@devai-nyx/authority', async (importOriginal) => {
    const actual = await importOriginal<AuthorityModule>();
    return {
      ...actual,
      readFileSync: ((...args: Parameters<AuthorityModule['readFileSync']>) =>
        String(args[0]).endsWith('trusted-local-rc-verifier-package.json')
          ? JSON.stringify(policy)
          : actual.readFileSync(...args)) as AuthorityModule['readFileSync'],
    };
  });
  return import('../../src/services/ci-scaffold/index.js');
}

afterEach(() => {
  vi.doUnmock('@devai-nyx/authority');
  vi.resetModules();
});

describe('CI scaffold verifier policy boundary', () => {
  it.each([
    [
      'package container',
      (policy: VerifierPolicy) => {
        policy.package = undefined;
      },
    ],
    ['package name', (policy: VerifierPolicy) => (policy.package = { name: '', version: '1.2.3' })],
    [
      'package version',
      (policy: VerifierPolicy) => (policy.package = { name: '@fixture/verifier' }),
    ],
    [
      'package version with leading data',
      (policy: VerifierPolicy) => {
        if (policy.package !== undefined) policy.package.version = 'v1.2.3';
      },
    ],
    [
      'package version with trailing data',
      (policy: VerifierPolicy) => {
        if (policy.package !== undefined) policy.package.version = '1.2.3-dev';
      },
    ],
    [
      'authentication container',
      (policy: VerifierPolicy) => {
        policy.authentication = undefined;
      },
    ],
    [
      'package secret',
      (policy: VerifierPolicy) => (policy.authentication = { github_token_fallback: false }),
    ],
    [
      'token fallback',
      (policy: VerifierPolicy) =>
        (policy.authentication = { secret: 'PACKAGES_READ_TOKEN', github_token_fallback: true }),
    ],
    [
      'contents permission',
      (policy: VerifierPolicy) =>
        (policy.workflow_permissions = { contents: 'write', packages: 'read', checks: 'write' }),
    ],
    [
      'packages permission',
      (policy: VerifierPolicy) =>
        (policy.workflow_permissions = { contents: 'read', packages: 'write', checks: 'write' }),
    ],
    [
      'checks permission',
      (policy: VerifierPolicy) =>
        (policy.workflow_permissions = { contents: 'read', packages: 'read', checks: 'read' }),
    ],
    [
      'verifier container',
      (policy: VerifierPolicy) => {
        policy.verifier = undefined;
      },
    ],
    [
      'verifier root',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.root = 'dist/runtime/untrusted';
      },
    ],
    [
      'provenance digest',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.provenance_sha256 = '0'.repeat(63);
      },
    ],
    [
      'provenance digest with leading data',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.provenance_sha256 = `g${'0'.repeat(64)}`;
      },
    ],
    [
      'provenance digest with trailing data',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.provenance_sha256 = `${'0'.repeat(64)}g`;
      },
    ],
    [
      'source commit',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.source_commit = '0'.repeat(39);
      },
    ],
    [
      'source commit with leading data',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.source_commit = `g${'0'.repeat(40)}`;
      },
    ],
    [
      'source commit with trailing data',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.source_commit = `${'0'.repeat(40)}g`;
      },
    ],
    [
      'payload population',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.payload_file_count = 20;
      },
    ],
    [
      'binary population',
      (policy: VerifierPolicy) => {
        if (policy.verifier !== undefined) policy.verifier.binaries = {};
      },
    ],
    [
      'external duplicate container',
      (policy: VerifierPolicy) => {
        policy.external_duplicate = undefined;
      },
    ],
    [
      'duplicate variable',
      (policy: VerifierPolicy) => {
        if (policy.external_duplicate !== undefined) policy.external_duplicate.name = 'UNTRUSTED';
      },
    ],
    [
      'duplicate requirement',
      (policy: VerifierPolicy) => {
        if (policy.external_duplicate !== undefined) policy.external_duplicate.required = false;
      },
    ],
    [
      'sole trust root',
      (policy: VerifierPolicy) => {
        if (policy.external_duplicate !== undefined)
          policy.external_duplicate.sole_trust_root = true;
      },
    ],
    ['adopter fallback', (policy: VerifierPolicy) => (policy.adopter_fallbacks = ['mutable'])],
  ])('refuses a policy with invalid %s', async (_field, mutate) => {
    const policy = structuredClone(canonicalPolicy);
    mutate(policy);
    await expect(importScaffoldWithPolicy(policy)).rejects.toThrow(
      'CI_SCAFFOLD_VERIFIER_PACKAGE_POLICY_INVALID',
    );
  });

  it('accepts multi-digit SemVer components in an exact package version', async () => {
    const policy = structuredClone(canonicalPolicy);
    if (policy.package === undefined) throw new Error('canonical package policy missing');
    policy.package.version = '10.11.12';

    const scaffold = await importScaffoldWithPolicy(policy);
    expect(scaffold.ledgerVerificationWorkflow()).toContain(
      "const selected = metadata.versions?.['10.11.12'];",
    );
  });
});
