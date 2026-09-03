import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildReleasePlanReceipt } from '../../src/services/release-lifecycle.js';

vi.mock('../../src/authority/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/authority/index.js')>()),
  declaredInvocationAuthority: () => ({
    kind: 'human',
    role: 'inspector',
    declaration_source: 'cli-flag',
  }),
}));

const { installReleaseLifecycleCommandAdapters, releasePreflight } =
  await import('../../src/commands/release/lifecycle.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function captureAction() {
  let handler: ((options: Record<string, unknown>) => Promise<void>) | undefined;
  const command = {
    option: () => command,
    action: (value: typeof handler) => {
      handler = value;
      return command;
    },
  };
  releasePreflight.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error('release preflight handler was not registered');
  return handler;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('release lifecycle command adapter composition', () => {
  it('executes the public preflight through the installed local provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-release-command-'));
    mkdirSync(join(root, 'law/policy'), { recursive: true });
    mkdirSync(join(root, 'receipts'), { recursive: true });
    for (const name of [
      'release-verification.json',
      'release-lifecycle.json',
      'action-registry.json',
    ]) {
      cpSync(join(process.cwd(), 'law/policy', name), join(root, 'law/policy', name));
    }
    const commit = '5'.repeat(40);
    const tree = '6'.repeat(40);
    const intent = {
      schemaVersion: '1.0.0',
      release_unit: '@aarusso-nyx/devai',
      current_version: '1.4.5',
      target_version: '1.5.0',
      support: 'current',
      change_kind: 'behavioral',
      changed_paths: ['packages/cli/src/services/release-lifecycle-execution.ts'],
      changed_packages: ['@aarusso-nyx/devai'],
      candidate: { commit, tree },
      base: { commit: '7'.repeat(40), tree: '8'.repeat(40) },
    };
    writeFileSync(join(root, 'release-intent.json'), `${canonicalJson(intent)}\n`);
    const receipt = buildReleasePlanReceipt({
      repository_id: 'aarusso-nyx/devai',
      intent_path: 'release-intent.json',
      intent,
      release_verification_profile: json(join(root, 'law/policy/release-verification.json')),
      release_lifecycle_policy: json(join(root, 'law/policy/release-lifecycle.json')),
      action_registry: json(join(root, 'law/policy/action-registry.json')),
    });
    writeFileSync(join(root, 'receipts/plan.json'), `${canonicalJson(receipt)}\n`);
    const manifestDigest = 'a'.repeat(64);
    const request = {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release preflight',
      repository_locator: { id: 'aarusso-nyx/devai', commit, tree },
      candidate_locator: {
        commit,
        tree,
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            package_roster: [
              {
                package_id: '@aarusso-nyx/devai',
                manifest_path: 'package.json',
                manifest_digest_sha256: manifestDigest,
              },
            ],
          },
        ],
      },
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: receipt.receipt_id,
          receipt_digest_sha256: receipt.receipt_digest_sha256,
          path: 'receipts/plan.json',
        },
      ],
    } as const;
    const requestPath = join(root, 'request.json');
    writeFileSync(requestPath, `${canonicalJson(request)}\n`);
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      material: {
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            packages: [
              {
                package_id: '@aarusso-nyx/devai',
                manifest: { path: 'package.json', sha256: manifestDigest, size_bytes: 1 },
                tarball: null,
                sbom: null,
                evidence_manifest: null,
                provider_result: null,
                trust: null,
              },
            ],
          },
        ],
        inputs: [
          {
            kind: 'release-lifecycle-policy',
            path: 'law/policy/release-lifecycle.json',
            sha256: canonicalSha256(json(join(root, 'law/policy/release-lifecycle.json'))),
          },
        ],
        evidence: {
          manifest_digest_sha256: 'b'.repeat(64),
          receipt_digests: [receipt.receipt_digest_sha256],
          independently_checkable: true as const,
        },
        artifacts: [],
      },
    }));
    cleanups.push(
      installReleaseLifecycleCommandAdapters({
        provider: () => provider,
        offline_verification_provider: () => undefined,
        authorization: () => undefined,
        offline_receipt_verifier: () => undefined,
        publication_controls: () => undefined,
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await withAuthorityHostTestScope(() =>
      captureAction()({ request: requestPath, repoRoot: root, stateRoot: join(root, 'state') }),
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));
  });
});
