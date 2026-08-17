import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTrustedLocalRcBoundary } from '../../src/commands/doctor.js';
import {
  buildCiScaffoldPlan,
} from '../../src/services/ci-scaffold/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-doctor-attested-'));
  roots.push(root);
  put(root, '.devai/config/project.json', {
    ci_economy: {
      attested_rc: {
        profile: 'rc',
        transport: 'protected-tag-v1',
        tag_prefix: 'devai-local-evidence/',
        binding: 'exact-tree',
        required_check: 'verified-local-rc',
        failure_mode: 'fail-closed',
        local_only_nodes: ['test:mutation'],
      },
    },
  });
  put(root, 'package.json', {
    scripts: {
      'test:mutation': 'pnpm -r stryker',
      'devai:rc:prepare': 'node tools/devai-rc.mjs prepare',
      'devai:rc:publish': 'node tools/devai-rc.mjs publish',
    },
  });
  put(root, 'test-tasks.json', {
    tasks: [{ nodeId: 'test:mutation', argv: ['pnpm', 'run', 'test:mutation'] }],
  });
  const keys = generateKeyPairSync('ed25519');
  put(root, 'law/policy/devai-local-rc-trust-store.json', {
    schemaVersion: '1.0.0',
    trustedSigners: [
      {
        signerId: 'stynx-inspector-workstation-01',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
    revokedSignerIds: [],
  });
  put(root, 'law/policy/devai-local-rc-toolchain.json', { node: '24.15.0', pnpm: '9.15.0' });
  put(root, 'law/policy/devai-local-rc-environment.json', {});
  const plan = buildCiScaffoldPlan({ targetRoot: root });
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
  return root;
}

describe('doctor trusted local RC boundary', () => {
  it('reports local execution, remote verification, transport, tree binding, signer trust, and no fallback separately', () => {
    const result = checkTrustedLocalRcBoundary(fixture());
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({
      local_rc_execution_configured: true,
      remote_receipt_verification_configured: true,
      proof_transport_configured: true,
      exact_tree_binding_configured: true,
      signer_trust_configured: true,
      remote_workflow_can_execute_local_only_node: false,
      remote_mutation_fallback_configured: false,
    });
  });

  it('fails when any workflow can execute mutation', () => {
    const root = fixture();
    put(root, '.github/workflows/hardening.yml', 'on: workflow_dispatch\njobs:\n  mutation:\n    steps:\n      - run: pnpm exec stryker run\n');
    const result = checkTrustedLocalRcBoundary(root);
    expect(result.ok).toBe(false);
    expect(result.info).toMatchObject({ remote_workflow_can_execute_local_only_node: true });
    expect(result.errors?.join('\n')).toContain('direct Stryker invocation');
  });
});
