import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildReleasePlanReceipt } from '../../src/services/release-lifecycle.js';

const { runChecks } = vi.hoisted(() => ({ runChecks: vi.fn() }));
vi.mock('../../src/services/check-runner/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/index.js')>()),
  runCheckTasks: runChecks,
}));

vi.mock('../../src/authority/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/authority/index.js')>()),
  declaredInvocationAuthority: () => ({
    kind: 'human',
    role: 'inspector',
    declaration_source: 'cli-flag',
  }),
}));

const { installReleaseLifecycleCommandAdapters, releasePreflight, releaseResume } =
  await import('../../src/commands/release/lifecycle.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function captureAction(definition = releasePreflight) {
  let handler: ((options: Record<string, unknown>) => Promise<void>) | undefined;
  const command = {
    option: () => command,
    action: (value: typeof handler) => {
      handler = value;
      return command;
    },
  };
  definition.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error(`${definition.name} handler was not registered`);
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
    const manifestBytes = `${canonicalJson({ name: '@aarusso-nyx/devai', version: '1.5.0' })}\n`;
    writeFileSync(join(root, 'package.json'), manifestBytes);
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
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
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
    const uninstall = installReleaseLifecycleCommandAdapters({
      provider: () => provider,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(uninstall);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await withAuthorityHostTestScope(() =>
      captureAction()({ request: requestPath, repoRoot: root, stateRoot: join(root, 'state') }),
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));

    uninstall();
    output.mockClear();
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runChecks.mockReturnValue({
      schemaVersion: '1.0.0',
      operation: 'run',
      plan: {},
      execution: [
        {
          nodeId: 'format',
          taskKey: 'format',
          disposition: 'executed',
          outcome: 'PASS',
          reason: 'required-floor',
          durationMs: 1,
        },
      ],
      preflightReceipt: {
        digest: 'd'.repeat(64),
        path: '.devai/cache/preflight-receipts/test.json',
        value: {},
      },
      exitCode: 0,
    });
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: requestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(runChecks).toHaveBeenCalledOnce();
    expect(errorOutput.mock.calls, JSON.stringify(errorOutput.mock.calls)).toEqual([]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));

    const resumeRequestPath = join(root, 'resume-request.json');
    writeFileSync(
      resumeRequestPath,
      `${canonicalJson({
        schemaVersion: '1.0.0',
        request_kind: 'release-lifecycle-request',
        action_id: 'release resume',
        repository_locator: request.repository_locator,
        candidate_locator: request.candidate_locator,
      })}\n`,
    );
    output.mockClear();
    await captureAction(releaseResume)({
      request: resumeRequestPath,
      repoRoot: root,
      stateRoot: join(root, 'stock-state'),
    });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"next_action":"release certify"'));

    output.mockClear();
    errorOutput.mockClear();
    symlinkSync('plan.json', join(root, 'receipts/plan-link.json'));
    const unsafeRequestPath = join(root, 'unsafe-request.json');
    writeFileSync(
      unsafeRequestPath,
      `${canonicalJson({
        ...request,
        receipt_locators: [{ ...request.receipt_locators[0], path: 'receipts/plan-link.json' }],
      })}\n`,
    );
    const unsafeProvider = vi.fn(() => ({ outcome: 'failure' as const }));
    cleanups.push(
      installReleaseLifecycleCommandAdapters({
        provider: () => unsafeProvider,
        offline_verification_provider: () => undefined,
        authorization: () => undefined,
        offline_receipt_verifier: () => undefined,
        publication_controls: () => undefined,
      }),
    );
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: unsafeRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'unsafe-state'),
      }),
    );
    expect(unsafeProvider).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining('release-receipt-path-unsafe'),
    );
  });
});
import { createHash } from 'node:crypto';
