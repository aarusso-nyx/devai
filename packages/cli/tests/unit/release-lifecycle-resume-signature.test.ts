import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const { resume } = vi.hoisted(() => ({ resume: vi.fn() }));

vi.mock('../../src/services/release-lifecycle-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-lifecycle-execution.js')>()),
  resumeReleaseLifecycleExecution: resume,
}));

const { installReleaseLifecycleCommandAdapters, releaseResume } =
  await import('../../src/commands/release/lifecycle.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  resume.mockReset();
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
  releaseResume.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error('release resume handler was not registered');
  return handler;
}

describe('release resume signature adapter', () => {
  it('forwards only the trusted host verifier and fails closed when it is absent', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-release-resume-signature-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const request = {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release resume',
      repository_locator: {
        id: 'fixture/repository',
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      },
      candidate_locator: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        release_units: [
          {
            release_unit: '@fixture/package',
            version: '1.0.0',
            package_roster: [
              {
                package_id: '@fixture/package',
                manifest_path: 'package.json',
                manifest_digest_sha256: 'c'.repeat(64),
              },
            ],
          },
        ],
      },
    } as const;
    const requestPath = join(root, 'request.json');
    const statesPath = join(root, 'states.json');
    const recordsPath = join(root, 'records.json');
    const publicationPath = join(root, 'publication.json');
    writeFileSync(requestPath, `${canonicalJson(request)}\n`);
    writeFileSync(statesPath, '[]\n');
    writeFileSync(recordsPath, '[]\n');
    writeFileSync(publicationPath, `${canonicalJson({ receipt: 'external' })}\n`);
    const trustedVerifier = vi.fn(async () => true);
    const verifierFactory = vi.fn(() => trustedVerifier);
    const uninstall = installReleaseLifecycleCommandAdapters({
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
      publication_signature_verifier: verifierFactory,
    });
    cleanups.push(uninstall);
    resume.mockImplementation(async (input) => {
      expect(input.publication_receipt).toEqual({ receipt: 'external' });
      expect(await input.verify_signature?.({} as never)).toBe(true);
      return { next_action: null, next_outcome: 'complete' };
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: requestPath,
        repoRoot: root,
        stateChain: statesPath,
        storeRecords: recordsPath,
        publicationReceipt: publicationPath,
      }),
    );
    expect(verifierFactory).toHaveBeenCalledWith(request);
    expect(trustedVerifier).toHaveBeenCalledOnce();
    expect(errorOutput).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"next_outcome":"complete"'));
    uninstall();

    resume.mockImplementation(async (input) => {
      expect(await input.verify_signature?.({} as never)).toBe(false);
      return { next_action: null, next_outcome: 'blocked' };
    });
    const noVerifier = installReleaseLifecycleCommandAdapters({
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(noVerifier);
    output.mockClear();
    errorOutput.mockClear();
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: requestPath,
        repoRoot: root,
        stateChain: statesPath,
        storeRecords: recordsPath,
        publicationReceipt: publicationPath,
      }),
    );
    expect(errorOutput).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"next_outcome":"blocked"'));
  });
});
