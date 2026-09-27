import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  captureProtectedReleaseRepositoryIdentity,
  type ProtectedReleaseRepositoryIdentity,
} from './release-repository-identity.js';

/** External operator controls, never obtained from a candidate or CLI request. */
export interface ProtectedReleaseRepositoryControls {
  readonly repository_root: string;
  readonly authority_repository_id: string;
  readonly read_expected_release_repository_id: () => string;
  readonly repository: ProtectedReleaseRepositoryIdentity['repository'];
}

export interface ProtectedReleaseRepositoryContext {
  readonly identity: ProtectedReleaseRepositoryIdentity;
}

type RepositoryPin = Readonly<{ path: string; dev: bigint; ino: bigint }>;
interface RepositoryContextState {
  readonly configuredRoot: string;
  readonly root: string;
  readonly expected: () => string;
  readonly identity: ProtectedReleaseRepositoryIdentity;
  readonly pins: readonly RepositoryPin[];
}
interface LiveRepositoryContext {
  readonly state: RepositoryContextState;
  active: boolean;
}
const repositoryContexts = new WeakMap<ProtectedReleaseRepositoryContext, RepositoryContextState>();
const liveRepositoryContexts = new AsyncLocalStorage<LiveRepositoryContext>();

export function repositoryIdentityFailure(): never {
  throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}

function repositoryGit(root: string, args: readonly string[]): string {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return repositoryIdentityFailure();
  const environment = Object.freeze({
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  if (
    Object.keys(environment)
      .filter((key) => key.startsWith('GIT_'))
      .sort()
      .join(',') !== 'GIT_CONFIG_GLOBAL,GIT_CONFIG_NOSYSTEM,GIT_CONFIG_SYSTEM' ||
    environment.GIT_CONFIG_NOSYSTEM !== '1' ||
    environment.GIT_CONFIG_SYSTEM !== '/dev/null' ||
    environment.GIT_CONFIG_GLOBAL !== '/dev/null'
  )
    return repositoryIdentityFailure();
  const result = nodeSpawnSync(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '--no-replace-objects',
      '--no-lazy-fetch',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    {
      cwd: root,
      env: environment,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  if (result.status !== 0 || result.signal !== null || result.error !== undefined)
    return repositoryIdentityFailure();
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

function repositoryPin(path: string): RepositoryPin {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    return repositoryIdentityFailure();
  return Object.freeze({ path, dev: info.dev, ino: info.ino });
}

function repositoryProbe(configuredRoot: string) {
  if (!isAbsolute(configuredRoot) || /[\p{Cc}\p{Cs}]/u.test(configuredRoot))
    return repositoryIdentityFailure();
  const root = realpathSync(configuredRoot);
  if (!lstatSync(root).isDirectory()) return repositoryIdentityFailure();
  const before = [repositoryPin(root), repositoryPin(resolve(root, '.git'))];
  // Override worktree-config resolution only while examining the common local
  // config; any declaration of the extension is rejected before rev-parse.
  const config = repositoryGit(root, [
    '-c',
    'extensions.worktreeConfig=false',
    'config',
    '--local',
    '--no-includes',
    '--null',
    '--list',
  ]);
  const origin: string[] = [];
  if (config !== '' && !config.endsWith('\0')) return repositoryIdentityFailure();
  for (const entry of config === '' ? [] : config.slice(0, -1).split('\0')) {
    const delimiter = entry.indexOf('\n');
    const key = delimiter === -1 ? entry : entry.slice(0, delimiter);
    const firstDot = key.indexOf('.');
    const lastDot = key.lastIndexOf('.');
    const section = key.slice(0, firstDot).toLowerCase();
    const variable = key.slice(lastDot + 1).toLowerCase();
    // Git section/variable names are case-insensitive; subsection names are not.
    // remote.Origin must never stand in for the named remote.origin.
    const subsection = firstDot === lastDot ? undefined : key.slice(firstDot + 1, lastDot);
    const value = delimiter === -1 ? undefined : entry.slice(delimiter + 1);
    if (
      ((section === 'include' || section === 'includeif') && variable === 'path') ||
      (section === 'extensions' && variable === 'worktreeconfig') ||
      (section === 'url' && (variable === 'insteadof' || variable === 'pushinsteadof')) ||
      (section === 'remote' && subsection === 'origin' && variable === 'pushurl')
    )
      return repositoryIdentityFailure();
    if (section === 'remote' && subsection === 'origin' && variable === 'url') {
      if (value === undefined) return repositoryIdentityFailure();
      origin.push(value);
    }
  }
  if (origin.length !== 1) return repositoryIdentityFailure();
  const pathOutput = repositoryGit(root, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!pathOutput.endsWith('\n')) return repositoryIdentityFailure();
  const pathFields = pathOutput.slice(0, -1).split('\n');
  if (
    pathFields.length !== 3 ||
    pathFields.some((value) => value.length === 0 || /[\p{Cc}\p{Cs}]/u.test(value))
  )
    return repositoryIdentityFailure();
  const [observedRoot, gitDirectory, commonDirectory] = pathFields;
  if (observedRoot !== root || gitDirectory === undefined || commonDirectory === undefined)
    return repositoryIdentityFailure();
  if (
    realpathSync(gitDirectory) !== gitDirectory ||
    realpathSync(commonDirectory) !== commonDirectory
  )
    return repositoryIdentityFailure();
  const pins = [
    ...before,
    repositoryPin(gitDirectory),
    repositoryPin(commonDirectory),
    repositoryPin(resolve(commonDirectory, 'config')),
  ];
  const objectOutput = repositoryGit(root, ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}']);
  if (!objectOutput.endsWith('\n')) return repositoryIdentityFailure();
  const objectFields = objectOutput.slice(0, -1).split('\n');
  if (
    objectFields.length !== 2 ||
    objectFields.some(
      (value) =>
        value.length === 0 ||
        /[\p{Cc}\p{Cs}]/u.test(value) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value),
    )
  )
    return repositoryIdentityFailure();
  const [commit, tree] = objectFields;
  if (commit === undefined || tree === undefined || commit.length !== tree.length)
    return repositoryIdentityFailure();
  for (const pin of pins) {
    const current = repositoryPin(pin.path);
    if (current.dev !== pin.dev || current.ino !== pin.ino) return repositoryIdentityFailure();
  }
  return { root, origin: origin[0], commit, tree, pins: Object.freeze(pins) };
}

/** Read-only capture; possession of this context grants no role, action or effect. */
export function createProtectedReleaseRepositoryContext(
  controls: ProtectedReleaseRepositoryControls,
): ProtectedReleaseRepositoryContext {
  try {
    const expected = controls.read_expected_release_repository_id;
    if (typeof expected !== 'function') return repositoryIdentityFailure();
    const expectedId = expected();
    const configuredRoot = controls.repository_root;
    const probe = repositoryProbe(configuredRoot);
    const identity = captureProtectedReleaseRepositoryIdentity({
      authority_repository_id: controls.authority_repository_id,
      expected_release_repository_id: expectedId,
      origin_url: probe.origin,
      repository: controls.repository,
    });
    if (identity.repository.commit !== probe.commit || identity.repository.tree !== probe.tree)
      return repositoryIdentityFailure();
    const context = Object.freeze({ identity });
    repositoryContexts.set(context, {
      configuredRoot,
      root: probe.root,
      identity,
      expected,
      pins: probe.pins,
    });
    return context;
  } catch {
    return repositoryIdentityFailure();
  }
}

/** Every caller performs a fresh host/config/HEAD check, not a cached identity lookup. */
export function readProtectedReleaseRepositoryIdentity(): ProtectedReleaseRepositoryIdentity {
  try {
    const live = liveRepositoryContexts.getStore();
    if (!live?.active) return repositoryIdentityFailure();
    const state = live.state;
    if (state.expected() !== state.identity.expected_release_repository_id)
      return repositoryIdentityFailure();
    const probe = repositoryProbe(state.configuredRoot);
    if (
      probe.root !== state.root ||
      probe.origin !== state.identity.origin_url ||
      probe.commit !== state.identity.repository.commit ||
      probe.tree !== state.identity.repository.tree ||
      probe.pins.length !== state.pins.length ||
      probe.pins.some((pin, index) => {
        const initial = state.pins[index];
        return initial?.path !== pin.path || initial.dev !== pin.dev || initial.ino !== pin.ino;
      })
    )
      return repositoryIdentityFailure();
    return state.identity;
  } catch {
    return repositoryIdentityFailure();
  }
}

/** The broker's authority sources must belong to the very same host-owned checkout. */
export function assertProtectedReleaseRepositoryRoot(root: string): void {
  try {
    const live = liveRepositoryContexts.getStore();
    if (!live?.active || !isAbsolute(root) || realpathSync(root) !== live.state.root)
      return repositoryIdentityFailure();
  } catch {
    return repositoryIdentityFailure();
  }
}

/** Host invocation lifetime only. Nested selection and escaped descendants refuse. */
export async function withProtectedReleaseRepositoryContext<T>(
  context: ProtectedReleaseRepositoryContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const state = repositoryContexts.get(context);
  if (state === undefined || liveRepositoryContexts.getStore() !== undefined)
    return repositoryIdentityFailure();
  const live: LiveRepositoryContext = { state, active: true };
  return liveRepositoryContexts.run(live, async () => {
    try {
      readProtectedReleaseRepositoryIdentity();
      return await callback();
    } finally {
      live.active = false;
    }
  });
}
