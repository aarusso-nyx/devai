import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  action: vi.fn(),
  offline: vi.fn(),
  resume: vi.fn(),
  validate: vi.fn(),
  verifyState: vi.fn(),
  policyGuard: vi.fn(),
  planResolver: vi.fn(),
  buildReceipt: vi.fn(),
  localProvider: vi.fn(),
  certificationProvider: vi.fn(),
  prepareProvider: vi.fn(),
  authority: { value: { actor: { kind: 'human' } } as unknown },
  storeStates: { value: [] as unknown[] },
  storeRecords: { value: [] as unknown[] },
  storeHead: { value: { head: true } as unknown },
  storeConstructor: vi.fn(),
}));

vi.mock('../../src/authority/index.js', () => ({
  declaredInvocationAuthority: () => doubles.authority.value,
}));

vi.mock('../../src/services/release-lifecycle-execution.js', () => ({
  ReleaseLifecycleFileStore: class {
    constructor(...args: unknown[]) {
      doubles.storeConstructor(...args);
    }
    readStateRecords() {
      return doubles.storeStates.value;
    }
    readStoreRecords() {
      return doubles.storeRecords.value;
    }
    readHead() {
      return doubles.storeHead.value;
    }
  },
  executeOfflineVerification: doubles.offline,
  executeReleaseLifecycleAction: doubles.action,
  resumeReleaseLifecycleExecution: doubles.resume,
  validateReleaseLifecycleRequest: doubles.validate,
  verifyReleaseStateIdentity: doubles.verifyState,
}));

vi.mock('../../src/services/release-policy-resolution.js', () => ({
  createResolvedReleasePlanInputResolver: doubles.planResolver,
  isVerifiedReleasePolicyResolution: doubles.policyGuard,
}));

vi.mock('../../src/services/release-lifecycle.js', () => ({
  buildResolvedReleasePlanReceipt: doubles.buildReceipt,
}));

vi.mock('../../src/services/release-lifecycle-local-adapters.js', () => ({
  builtInReleaseLifecycleLocalProvider: doubles.localProvider,
}));

vi.mock('../../src/services/release-lifecycle-certification.js', () => ({
  createReleaseCertificationProvider: doubles.certificationProvider,
}));

vi.mock('../../src/services/release-prepare-kernel.js', () => ({
  createReleasePrepareProvider: doubles.prepareProvider,
}));

const lifecycle = await import('../../src/commands/release/lifecycle.js');

type Definition = typeof lifecycle.releasePlan;
type Handler = (options: Record<string, unknown>) => void | Promise<void>;

const cleanups: Array<() => void> = [];

beforeEach(() => {
  process.exitCode = undefined;
  doubles.authority.value = { actor: { kind: 'human' } };
  doubles.storeStates.value = [];
  doubles.storeRecords.value = [];
  doubles.storeHead.value = { head: true };
  doubles.policyGuard.mockReturnValue(true);
  doubles.planResolver.mockReturnValue(vi.fn());
  doubles.localProvider.mockReturnValue(undefined);
  doubles.action.mockResolvedValue({
    ok: true,
    state: { state_id: 'state-1', state: 'preflight_passed' },
  });
  doubles.offline.mockResolvedValue({
    ok: true,
    receipt: { receipt_id: 'offline-1', verdict: 'pass' },
  });
  doubles.resume.mockResolvedValue({ observation_id: 'observation-1', next_outcome: 'ready' });
});

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-command-boundary-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function capture(definition: Definition): {
  readonly command: ReturnType<typeof vi.fn>;
  readonly option: ReturnType<typeof vi.fn>;
  readonly handler: Handler;
} {
  let handler: Handler | undefined;
  const option = vi.fn();
  const commandObject = {
    option: (...args: unknown[]) => {
      option(...args);
      return commandObject;
    },
    action: (value: Handler) => {
      handler = value;
      return commandObject;
    },
  };
  const command = vi.fn(() => commandObject);
  definition.register({ command } as unknown as CAC);
  if (handler === undefined) throw new Error('command handler missing');
  return { command, option, handler };
}

const request = {
  schemaVersion: '1.0.0',
  request_kind: 'release-lifecycle-request',
  action_id: 'release preflight',
  repository_locator: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  candidate_locator: {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    release_units: [{ release_unit: '@fixture/package', version: '1.0.0', package_roster: [] }],
  },
  receipt_locators: [],
} as const;

const resolution = {
  repository: request.repository_locator,
  release_unit: '@fixture/package',
  readInput: vi.fn(),
};

function install(overrides: Record<string, unknown> = {}): void {
  const uninstall = lifecycle.installReleaseLifecycleCommandAdapters({
    policy_resolution: () => resolution,
    provider: () => undefined,
    offline_verification_provider: () => undefined,
    authorization: () => undefined,
    offline_receipt_verifier: () => undefined,
    publication_controls: () => undefined,
    ...overrides,
  } as never);
  cleanups.push(uninstall);
}

describe('release lifecycle command boundaries', () => {
  it('registers the exact public command metadata and option contracts', () => {
    const cases = [
      [
        lifecycle.releasePlan,
        'release plan',
        'Resolve the deterministic nine-action release plan and emit its receipt.',
        ['release-plan', 'Emit a deterministic release plan receipt'],
        [
          ['--repo-root <path>', 'Repository root containing the bound policies'],
          ['--intent <path>', 'Release intent JSON (required)'],
          ['--repository <id>', 'Exact repository identity (required)'],
          ['--human', 'Human-readable output'],
        ],
      ],
      [
        lifecycle.releasePreflight,
        'release preflight',
        'Run the cheap mandatory floor and bind a passing plan receipt.',
        ['release-preflight', 'Run the cheap mandatory floor and bind a passing plan receipt.'],
      ],
      [
        lifecycle.releaseCertify,
        'release certify',
        'Run the selected candidate-bound certification DAG.',
        ['release-certify', 'Run the selected candidate-bound certification DAG.'],
      ],
      [
        lifecycle.releasePrepare,
        'release prepare',
        'Prepare deterministic packages, manifests, and software bills of materials.',
        [
          'release-prepare',
          'Prepare deterministic packages, manifests, and software bills of materials.',
        ],
      ],
      [
        lifecycle.releaseExport,
        'release export',
        'Export release evidence through the authorized verifier-provider boundary.',
        [
          'release-export',
          'Export release evidence through the authorized verifier-provider boundary.',
        ],
      ],
      [
        lifecycle.releaseEvidencePublish,
        'release evidence-publish',
        'Publish exact offline-verified evidence with one-time Owner authorization.',
        [
          'release-evidence-publish',
          'Publish exact offline-verified evidence with one-time Owner authorization.',
        ],
      ],
      [
        lifecycle.releasePublish,
        'release publish',
        'Dispatch publication through the protected workflow boundary.',
        ['release-publish', 'Dispatch publication through the protected workflow boundary.'],
      ],
      [
        lifecycle.releaseOfflineVerify,
        'release offline-verify',
        'Verify exported artifacts without network access and emit a deterministic receipt.',
        ['release-offline-verify', 'Verify exported release artifacts without network access'],
        [
          ['--request <path>', 'Exact candidate-bound offline verification request JSON'],
          ['--exported-state <path>', 'Exact exported lifecycle state record'],
          ['--repo-root <path>', 'Repository root containing bound inputs'],
          ['--human', 'Human-readable output'],
        ],
      ],
      [
        lifecycle.releaseResume,
        'release resume',
        'Observe and reconcile the release lifecycle without executing the next action.',
        ['release-resume', 'Emit a pure release lifecycle observation'],
        [
          ['--request <path>', 'Exact release resume request (required for an empty state chain)'],
          ['--repo-root <path>', 'Repository root containing bound receipt inputs'],
          ['--state-root <path>', 'Protected append-only release state root'],
          ['--state-chain <path>', 'JSON array containing the persisted state chain'],
          [
            '--store-records <path>',
            'Optional JSON array containing append-only execution records',
          ],
          ['--store-head <path>', 'Optional canonical v2 store head'],
          ['--receipts <path>', 'Optional JSON array of plan/offline receipt documents'],
          ['--publication-receipt <path>', 'Signed external publication receipt'],
          ['--human', 'Human-readable output'],
        ],
      ],
    ] as const;
    const actionOptions = [
      ['--request <path>', 'Exact candidate-bound action request JSON'],
      ['--repo-root <path>', 'Repository root containing bound receipt inputs'],
      ['--state-root <path>', 'Protected append-only release state root'],
      ['--human', 'Human-readable output'],
    ];
    for (const [definition, name, description, commandArgs, explicitOptions] of cases) {
      expect(definition).toMatchObject({ name, description, authority: 'release_controller' });
      const registered = capture(definition);
      expect(registered.command).toHaveBeenCalledWith(...commandArgs);
      expect(registered.option.mock.calls).toEqual(explicitOptions ?? actionOptions);
    }
  });

  it('keeps adapter installation single-owner and makes stale cleanup harmless', () => {
    const first = lifecycle.installReleaseLifecycleCommandAdapters({} as never);
    expect(() => lifecycle.installReleaseLifecycleCommandAdapters({} as never)).toThrow(
      'release-command-adapters-already-installed',
    );
    first();
    const second = lifecycle.installReleaseLifecycleCommandAdapters({} as never);
    first();
    expect(() => lifecycle.installReleaseLifecycleCommandAdapters({} as never)).toThrow(
      'release-command-adapters-already-installed',
    );
    second();
  });

  it('preserves plan usage, allowlisted failures, fallback sanitization, and output modes', async () => {
    const root = tempRoot();
    const intent = {
      candidate: {
        commit: request.repository_locator.commit,
        tree: request.repository_locator.tree,
      },
      release_unit: '@fixture/package',
    };
    const intentPath = put(root, 'intent.json', intent);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const handler = capture(lifecycle.releasePlan).handler;
    await handler({});
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release plan: RELEASE_PLAN_USAGE: --intent and --repository are required\n',
    );
    expect(process.exitCode).toBe(2);

    install();
    doubles.buildReceipt.mockReturnValue({ receipt_id: 'plan-1', verdict: 'pass' });
    await handler({ intent: intentPath, repository: 'fixture/repository', human: true });
    expect(stdout).toHaveBeenLastCalledWith('release plan: plan-1 -> pass\n');
    expect(process.exitCode).toBe(0);
    doubles.buildReceipt.mockReturnValue({ receipt_id: 'plan-2', verdict: 'fail' });
    await handler({ intent: intentPath, repository: 'fixture/repository' });
    expect(stdout).toHaveBeenLastCalledWith('{"receipt_id":"plan-2","verdict":"fail"}\n');
    expect(process.exitCode).toBe(2);

    const invalidIntentPath = put(root, 'invalid-intent.json', { candidate: null });
    await handler({ intent: invalidIntentPath, repository: 'fixture/repository' });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: rpl-input-unresolved\n',
    );
    doubles.policyGuard.mockReturnValueOnce(false);
    await handler({ intent: intentPath, repository: 'fixture/repository' });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: rpl-policy-source-unresolved\n',
    );

    for (const code of [
      'rpl-policy-source-unresolved',
      'rpl-package-identity-mismatch',
      'rpl-adopter-binding-mismatch',
      'rpl-policy-resolution-mismatch',
      'rpl-legacy-plan-non-authoritative',
      'rpl-input-unresolved',
      'release-receipt-path-unsafe',
      'release-request-projection-invalid',
      'release-request-action-mismatch',
      'release-request-identity-mismatch',
      'release-request-receipt-order-invalid',
      'release-receipt-identity-mismatch',
      'release-release-unit-bijection-invalid',
      'release-offline-state-missing',
      'release-offline-state-mismatch',
      'release-state-store-unsafe',
    ]) {
      doubles.buildReceipt.mockImplementationOnce(() => {
        throw new Error(code);
      });
      await handler({ intent: intentPath, repository: 'fixture/repository' });
      expect(stderr).toHaveBeenLastCalledWith(`devai release plan: RELEASE_PLAN_FAILED: ${code}\n`);
      expect(process.exitCode).toBe(1);
    }
    doubles.buildReceipt.mockImplementationOnce(() => {
      throw new Error('/secret/native/path');
    });
    await handler({ intent: intentPath, repository: 'fixture/repository' });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: rpl-policy-resolution-mismatch\n',
    );
  });

  it('discriminates local, remote, certification, preparation, and result boundaries', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    const provider = vi.fn();
    const authorization = vi.fn();
    const offlineReceiptVerifier = vi.fn();
    const artifactReader = vi.fn();
    const exportLimits = vi.fn(() => ({ max: 1 }));
    const publicationControls = vi.fn(() => ({ publish: true }));
    const certification = { certify: vi.fn() };
    const contentSource = { read: vi.fn() };
    const artifactSink = { write: vi.fn() };
    const preflightProvider = vi.fn(() => provider);
    doubles.certificationProvider.mockReturnValue(provider);
    doubles.prepareProvider.mockReturnValue(provider);
    doubles.localProvider.mockReturnValue(provider);
    install({
      preflight_provider: preflightProvider,
      certification_provider: () => certification,
      prepare_content_source: () => contentSource,
      artifact_sink: () => artifactSink,
      provider: () => provider,
      authorization: () => authorization,
      offline_receipt_verifier: () => offlineReceiptVerifier,
      artifact_reader: () => artifactReader,
      export_limits: exportLimits,
      publication_controls: publicationControls,
    });

    for (const definition of [
      lifecycle.releasePreflight,
      lifecycle.releaseCertify,
      lifecycle.releasePrepare,
      lifecycle.releaseExport,
      lifecycle.releaseEvidencePublish,
      lifecycle.releasePublish,
    ]) {
      const handler = capture(definition).handler;
      await handler({});
      expect(stderr).toHaveBeenLastCalledWith(
        `devai ${definition.name}: RELEASE_ACTION_USAGE: --request is required\n`,
      );
      doubles.storeStates.value =
        definition === lifecycle.releasePrepare ? [{ state: 'certified' }] : [];
      doubles.action.mockResolvedValueOnce({
        ok: true,
        state: { state_id: `${definition.name}-id`, state: `${definition.name}-state` },
      });
      await handler({
        request: requestPath,
        repoRoot: root,
        stateRoot: join(root, 'state'),
        human: true,
      });
      expect(stdout).toHaveBeenLastCalledWith(
        `devai ${definition.name}: ${definition.name}-id -> ${definition.name}-state\n`,
      );
      const input = doubles.action.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(input).toMatchObject({ action: definition.name, request, provider });
      expect('authorization' in input).toBe(
        definition === lifecycle.releaseEvidencePublish || definition === lifecycle.releasePublish,
      );
      expect('offlineReceiptVerifier' in input).toBe(
        definition === lifecycle.releaseEvidencePublish,
      );
      expect('artifactReader' in input).toBe(
        definition === lifecycle.releaseExport ||
          definition === lifecycle.releaseEvidencePublish ||
          definition === lifecycle.releasePublish,
      );
      expect('exportLimits' in input).toBe(
        definition === lifecycle.releaseExport ||
          definition === lifecycle.releaseEvidencePublish ||
          definition === lifecycle.releasePublish,
      );
      expect('publication_controls' in input).toBe(definition === lifecycle.releasePublish);
    }
    expect(preflightProvider).toHaveBeenCalledTimes(1);

    doubles.storeConstructor.mockClear();
    await capture(lifecycle.releasePreflight).handler({ request: requestPath, repoRoot: root });
    expect(doubles.storeConstructor).toHaveBeenLastCalledWith(
      join(root, '.devai/state/release-lifecycle'),
      request,
    );

    doubles.action.mockResolvedValueOnce({
      ok: false,
      code: 'fixture-code',
      phase: 'fixture-phase',
    });
    await capture(lifecycle.releasePreflight).handler({ request: requestPath, repoRoot: root });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release preflight: fixture-code: fixture-phase\n',
    );
    doubles.authority.value = undefined;
    await capture(lifecycle.releasePreflight).handler({ request: requestPath, repoRoot: root });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release preflight: RELEASE_ACTION_REQUEST_INVALID: release-request-projection-invalid\n',
    );
  });

  it.each([
    ['repository id', { repository: { ...resolution.repository, id: 'other/repository' } }],
    ['repository commit', { repository: { ...resolution.repository, commit: 'c'.repeat(40) } }],
    ['repository tree', { repository: { ...resolution.repository, tree: 'd'.repeat(40) } }],
    ['release unit', { release_unit: '@fixture/other' }],
  ])('rejects a policy resolution with a mismatched %s', async (_name, override) => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    install({
      policy_resolution: () => ({
        ...resolution,
        ...override,
      }),
      preflight_provider: () => vi.fn(),
    });

    await capture(lifecycle.releasePreflight).handler({ request: requestPath, repoRoot: root });

    expect(stderr).toHaveBeenCalledWith(
      'devai release preflight: RELEASE_ACTION_REQUEST_INVALID: rpl-policy-resolution-mismatch\n',
    );
    expect(doubles.action).not.toHaveBeenCalled();
  });

  it('requires certified state before constructing the prepare provider', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    doubles.storeStates.value = [{ state: 'preflight_passed' }];
    install({
      prepare_content_source: () => ({ read: vi.fn() }),
      artifact_sink: () => ({ write: vi.fn() }),
    });

    await capture(lifecycle.releasePrepare).handler({ request: requestPath, repoRoot: root });

    expect(stderr).toHaveBeenCalledWith(
      'devai release prepare: RELEASE_ACTION_REQUEST_INVALID: release-request-projection-invalid\n',
    );
    expect(doubles.prepareProvider).not.toHaveBeenCalled();
    expect(doubles.action).not.toHaveBeenCalled();
  });

  it('requires the offline receipt verifier for evidence publication', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    install({
      provider: () => vi.fn(),
      authorization: () => vi.fn(),
      artifact_reader: () => vi.fn(),
    });

    await capture(lifecycle.releaseEvidencePublish).handler({
      request: requestPath,
      repoRoot: root,
    });

    expect(stderr).toHaveBeenCalledWith(
      'devai release evidence-publish: RELEASE_ACTION_PROVIDER_UNAVAILABLE: the exact lifecycle adapter set is not installed; no store or provider effect occurred\n',
    );
    expect(doubles.action).not.toHaveBeenCalled();
  });

  it('refuses incomplete protected adapter sets before execution', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    const cases = [
      [lifecycle.releasePrepare, {}, 'RELEASE_ARTIFACT_SINK_UNAVAILABLE'],
      [lifecycle.releaseExport, { provider: () => vi.fn() }, 'RELEASE_ACTION_PROVIDER_UNAVAILABLE'],
      [
        lifecycle.releaseEvidencePublish,
        {
          provider: () => vi.fn(),
          artifact_reader: () => vi.fn(),
          offline_receipt_verifier: () => vi.fn(),
        },
        'RELEASE_AUTHORIZATION_PROVIDER_UNAVAILABLE',
      ],
      [
        lifecycle.releasePublish,
        { provider: () => vi.fn(), artifact_reader: () => vi.fn() },
        'RELEASE_AUTHORIZATION_PROVIDER_UNAVAILABLE',
      ],
    ] as const;
    for (const [definition, adapters, code] of cases) {
      stderr.mockClear();
      doubles.action.mockClear();
      install(adapters);
      await capture(definition).handler({ request: requestPath, repoRoot: root });
      expect(stderr).toHaveBeenLastCalledWith(
        `devai ${definition.name}: ${code}: the exact lifecycle adapter set is not installed; no store or provider effect occurred\n`,
      );
      expect(doubles.action).not.toHaveBeenCalled();
      cleanups.pop()?.();
    }
  });

  it('contains built-in provider reads within regular repository directories', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    mkdirSync(join(root, 'safe/nested'), { recursive: true });
    writeFileSync(join(root, 'safe/nested/input.bin'), 'safe');
    writeFileSync(join(root, 'safe/not-directory'), 'not a directory');
    const outside = tempRoot();
    writeFileSync(join(outside, 'input.bin'), 'outside');
    symlinkSync(outside, join(root, 'linked'));
    symlinkSync(outside, join(root, 'safe/linked'));
    const rootLink = join(tempRoot(), 'root-link');
    symlinkSync(root, rootLink);
    const rootFile = join(tempRoot(), 'root-file');
    writeFileSync(rootFile, 'not a directory');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    doubles.validate.mockReturnValue(request);
    const provider = vi.fn();

    for (const [repoRoot, path, succeeds] of [
      [root, 'safe/nested/input.bin', true],
      [root, '../input.bin', false],
      [root, 'linked/input.bin', false],
      [root, 'safe/linked/input.bin', false],
      [root, 'safe/not-directory/input.bin', false],
      [rootLink, 'safe/nested/input.bin', false],
      [rootFile, 'input.bin', false],
    ] as const) {
      stderr.mockClear();
      doubles.action.mockClear();
      doubles.localProvider.mockImplementationOnce((input: Record<string, unknown>) => {
        const read = input['read_contained_bytes'];
        if (typeof read !== 'function') throw new Error('contained reader missing');
        expect(Reflect.apply(read, undefined, [path])).toBeInstanceOf(Buffer);
        return provider;
      });
      install();
      await capture(lifecycle.releasePreflight).handler({ request: requestPath, repoRoot });
      if (succeeds) {
        expect(doubles.action).toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
      } else {
        expect(stderr).toHaveBeenLastCalledWith(
          'devai release preflight: RELEASE_ACTION_REQUEST_INVALID: release-receipt-path-unsafe\n',
        );
        expect(doubles.action).not.toHaveBeenCalled();
      }
      cleanups.pop()?.();
      doubles.action.mockClear();
    }
  });

  it('enforces offline verification aliases, adapters, state, results, and output modes', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const statePath = put(root, 'state.json', { state: 'exported' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const handler = capture(lifecycle.releaseOfflineVerify).handler;
    doubles.validate.mockReturnValue(request);
    doubles.verifyState.mockReturnValue({ state: 'exported' });
    await handler({});
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: RELEASE_OFFLINE_VERIFY_USAGE: --request or the deprecated --exported-state alias is required\n',
    );
    await handler({ request: requestPath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: RELEASE_OFFLINE_VERIFY_USAGE: --request and --exported-state are required for semantic verification\n',
    );
    install();
    stderr.mockClear();
    doubles.offline.mockClear();
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE: the trusted offline verifier adapter is not installed; no receipt was emitted\n',
    );
    expect(doubles.offline).not.toHaveBeenCalled();
    cleanups.pop()?.();
    const provider = vi.fn();
    const reader = vi.fn();

    install({ offline_verification_provider: () => provider });
    stderr.mockClear();
    doubles.offline.mockClear();
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE: the trusted offline verifier adapter is not installed; no receipt was emitted\n',
    );
    expect(doubles.offline).not.toHaveBeenCalled();
    cleanups.pop()?.();
    install({ artifact_reader: () => reader });
    stderr.mockClear();
    doubles.offline.mockClear();
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE: the trusted offline verifier adapter is not installed; no receipt was emitted\n',
    );
    expect(doubles.offline).not.toHaveBeenCalled();
    cleanups.pop()?.();

    const closures = { policy: true };
    const limits = { bytes: 1 };
    install({
      offline_verification_provider: () => provider,
      artifact_reader: () => reader,
      offline_policy_closures: () => closures,
      export_limits: () => limits,
    });
    doubles.offline.mockResolvedValueOnce({
      ok: false,
      code: 'offline-code',
      phase: 'offline-phase',
    });
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: offline-code: offline-phase\n',
    );
    doubles.offline.mockResolvedValueOnce({ ok: true, receipt: { receipt_id: 'offline-json' } });
    await handler({ request: requestPath, exportedState: statePath });
    expect(stdout).toHaveBeenLastCalledWith('{"receipt_id":"offline-json"}\n');
    expect(doubles.offline).toHaveBeenLastCalledWith({
      request,
      exported_state: { state: 'exported' },
      provider,
      artifactReader: reader,
      policyClosures: closures,
      exportLimits: limits,
    });
    doubles.offline.mockResolvedValueOnce({ ok: true, receipt: { receipt_id: 'offline-human' } });
    await handler({ request: requestPath, exportedState: statePath, human: true });
    expect(stdout).toHaveBeenLastCalledWith('release offline-verify: offline-human -> pass\n');
    doubles.verifyState.mockReturnValueOnce({ state: 'prepared' });
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: RELEASE_OFFLINE_VERIFY_INPUT_INVALID: release-offline-state-mismatch\n',
    );
    doubles.verifyState.mockReturnValueOnce(undefined);
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: RELEASE_OFFLINE_VERIFY_INPUT_INVALID: release-offline-state-missing\n',
    );
    doubles.validate.mockImplementationOnce(() => {
      throw new Error('/private/secret');
    });
    await handler({ request: requestPath, exportedState: statePath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release offline-verify: RELEASE_OFFLINE_VERIFY_INPUT_INVALID: release-request-projection-invalid\n',
    );
  });

  it('projects explicit resume inputs and keeps empty defaults distinct from built-in store data', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const statesPath = put(root, 'states.json', [{ fixture: 'state' }]);
    const recordsPath = put(root, 'records.json', [{ fixture: 'record' }]);
    const headPath = put(root, 'head.json', { fixture: 'head' });
    const receiptsPath = put(root, 'receipts.json', []);
    const publicationPath = put(root, 'publication.json', { fixture: 'publication' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const handler = capture(lifecycle.releaseResume).handler;
    await handler({});
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release resume: RELEASE_RESUME_USAGE: --state-chain or --request is required\n',
    );
    doubles.validate.mockReturnValue(request);
    doubles.verifyState.mockReturnValue({
      repository: request.repository_locator,
      candidate: {
        release_unit: '@fixture/package',
        version: '1.0.0',
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
      release_units: request.candidate_locator.release_units,
    });
    const verifier = vi.fn();
    const offlineVerifier = vi.fn();
    install({
      offline_receipt_verifier: () => offlineVerifier,
      publication_signature_verifier: () => verifier,
    });
    doubles.storeConstructor.mockClear();
    await handler({
      request: requestPath,
      repoRoot: root,
      stateChain: statesPath,
      storeRecords: recordsPath,
      storeHead: headPath,
      receipts: receiptsPath,
      publicationReceipt: publicationPath,
      human: true,
    });
    expect(stdout).toHaveBeenLastCalledWith('release resume: observation-1 -> ready\n');
    expect(doubles.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({
        states: [{ fixture: 'state' }],
        store_records: [{ fixture: 'record' }],
        store_head: { fixture: 'head' },
        repository: request.repository_locator,
        candidate_locator: request.candidate_locator,
        receipt_documents: [],
        publication_receipt: { fixture: 'publication' },
        verify_signature: verifier,
        offline_receipt_verifier: offlineVerifier,
      }),
    );
    expect(doubles.storeConstructor).not.toHaveBeenCalled();

    doubles.storeStates.value = [{ fixture: 'stored-state' }];
    doubles.storeRecords.value = [{ fixture: 'stored-record' }];
    doubles.storeHead.value = { fixture: 'stored-head' };
    doubles.resume.mockResolvedValueOnce({
      observation_id: 'observation-2',
      next_outcome: 'complete',
    });
    await handler({ request: requestPath, repoRoot: root });
    expect(stdout).toHaveBeenLastCalledWith(
      '{"observation_id":"observation-2","next_outcome":"complete"}\n',
    );
    expect(doubles.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({
        states: [{ fixture: 'stored-state' }],
        store_records: [{ fixture: 'stored-record' }],
        store_head: { fixture: 'stored-head' },
        receipt_documents: [],
        offline_receipt_verifier: offlineVerifier,
      }),
    );
    expect(doubles.storeConstructor).toHaveBeenLastCalledWith(
      join(root, '.devai/state/release-lifecycle'),
      request,
    );

    doubles.resume.mockClear();
    doubles.storeConstructor.mockClear();
    await handler({ request: requestPath, repoRoot: root, storeHead: headPath });
    expect(doubles.storeConstructor).not.toHaveBeenCalled();
    expect(doubles.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ states: [], store_head: { fixture: 'head' } }),
    );
    await handler({ request: requestPath, repoRoot: root, storeRecords: recordsPath });
    expect(doubles.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ states: [], store_records: [{ fixture: 'record' }] }),
    );
    await handler({ request: requestPath, repoRoot: root, stateChain: statesPath });
    expect(doubles.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ states: [{ fixture: 'state' }], store_records: [] }),
    );

    doubles.resume.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const resolvePlanInput = input['resolve_plan_input'];
      expect(typeof resolvePlanInput).toBe('function');
      expect(() => Reflect.apply(resolvePlanInput as () => unknown, undefined, [])).toThrow(
        'rpl-policy-source-unresolved',
      );
      return { observation_id: 'observation-unresolved', next_outcome: 'blocked' };
    });
    await handler({ request: requestPath, repoRoot: root, stateChain: statesPath });

    const currentReceiptsPath = put(root, 'current-receipts.json', [
      {
        receipt_kind: 'release-plan-receipt',
        schemaVersion: '2.0.0',
      },
    ]);
    doubles.planResolver.mockClear();
    await handler({
      request: requestPath,
      repoRoot: root,
      stateChain: statesPath,
      receipts: currentReceiptsPath,
    });
    expect(doubles.planResolver).toHaveBeenCalledWith([resolution]);

    for (const [name, receipt] of [
      ['null-receipt.json', null],
      ['primitive-receipt.json', 'not-a-receipt'],
      [
        'wrong-kind-receipt.json',
        { receipt_kind: 'offline-verification-receipt', schemaVersion: '2.0.0' },
      ],
      [
        'wrong-schema-receipt.json',
        { receipt_kind: 'release-plan-receipt', schemaVersion: '1.0.0' },
      ],
    ] as const) {
      const path = put(root, name, [receipt]);
      doubles.planResolver.mockClear();
      doubles.resume.mockImplementationOnce(async (input: Record<string, unknown>) => {
        const resolvePlanInput = input['resolve_plan_input'];
        expect(typeof resolvePlanInput).toBe('function');
        expect(() => Reflect.apply(resolvePlanInput as () => unknown, undefined, [])).toThrow(
          'rpl-policy-source-unresolved',
        );
        return { observation_id: name, next_outcome: 'blocked' };
      });

      await handler({
        request: requestPath,
        repoRoot: root,
        stateChain: statesPath,
        receipts: path,
      });

      expect(doubles.planResolver).not.toHaveBeenCalled();
    }

    doubles.planResolver.mockClear();
    doubles.verifyState.mockReturnValueOnce({
      repository: request.repository_locator,
      candidate: {
        release_unit: '@fixture/package',
        version: '1.0.0',
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
    });
    await handler({ stateChain: statesPath, receipts: currentReceiptsPath, repoRoot: root });
    expect(doubles.planResolver).toHaveBeenCalledWith([resolution]);

    for (const [name, value] of [
      ['bad-states.json', {}],
      ['bad-records.json', {}],
      ['bad-receipts.json', {}],
    ] as const) {
      put(root, name, value);
    }
    await handler({ stateChain: join(root, 'bad-states.json') });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release resume: RELEASE_RESUME_FAILED: release-request-projection-invalid\n',
    );
    await handler({
      request: requestPath,
      stateChain: statesPath,
      storeRecords: join(root, 'bad-records.json'),
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release resume: RELEASE_RESUME_FAILED: release-request-projection-invalid\n',
    );
    await handler({
      request: requestPath,
      stateChain: statesPath,
      receipts: join(root, 'bad-receipts.json'),
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release resume: RELEASE_RESUME_FAILED: release-request-projection-invalid\n',
    );
    doubles.resume.mockImplementationOnce(() => {
      throw new Error('/private/secret');
    });
    await handler({ request: requestPath, stateChain: statesPath });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai release resume: RELEASE_RESUME_FAILED: release-request-projection-invalid\n',
    );
  });

  it('keeps an unresolved resume plan resolver fail closed', async () => {
    const root = tempRoot();
    const requestPath = put(root, 'request.json', request);
    const statesPath = put(root, 'states.json', [{ fixture: 'state' }]);
    doubles.validate.mockReturnValue(request);
    doubles.verifyState.mockReturnValue({
      repository: request.repository_locator,
      candidate: {
        release_unit: '@fixture/package',
        version: '1.0.0',
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
    });
    let resolverError: string | undefined;
    doubles.resume.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const resolvePlanInput = input['resolve_plan_input'];
      try {
        Reflect.apply(resolvePlanInput as () => unknown, undefined, []);
      } catch (error) {
        resolverError = error instanceof Error ? error.message : String(error);
      }
      return { observation_id: 'unresolved', next_outcome: 'blocked' };
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    install();

    await capture(lifecycle.releaseResume).handler({
      request: requestPath,
      repoRoot: root,
      stateChain: statesPath,
    });

    expect(doubles.resume).toHaveBeenCalledOnce();
    expect(doubles.planResolver).not.toHaveBeenCalled();
    expect(resolverError).toBe('rpl-policy-source-unresolved');
  });

  it('resumes from an explicit state chain without reading a request', async () => {
    const root = tempRoot();
    const statesPath = put(root, 'states.json', [{ fixture: 'state' }]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    doubles.verifyState.mockReturnValue({
      repository: request.repository_locator,
      candidate: {
        release_unit: '@fixture/package',
        version: '1.0.0',
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
    });
    install();

    await capture(lifecycle.releaseResume).handler({ stateChain: statesPath, repoRoot: root });

    expect(stderr).not.toHaveBeenCalled();
    expect(doubles.validate).not.toHaveBeenCalled();
    expect(doubles.resume).toHaveBeenCalledOnce();
  });
});
