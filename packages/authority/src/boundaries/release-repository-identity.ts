import { types } from 'node:util';

/** Private identity domains. This data alone never authorizes a live host effect. */
export interface ProtectedReleaseRepositoryIdentity {
  readonly authority_repository_id: string;
  readonly expected_release_repository_id: string;
  readonly origin_url: string;
  readonly repository: {
    readonly id: string;
    readonly commit: string;
    readonly tree: string;
  };
}

const OWNER = '[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?';
const REPOSITORY = '[a-z0-9][a-z0-9._-]{0,99}';
const CANONICAL = new RegExp(`^${OWNER}/${REPOSITORY}$`, 'u');
const ORIGIN = new RegExp(
  `^(?:https://github\\.com/|ssh://git@github\\.com/|git@github\\.com:)(${OWNER}/${REPOSITORY})\\.git$`,
  'u',
);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function fail(): never {
  throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}

function exactText(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string') return fail();
  // JavaScript's $ may match before a final newline. Require the full raw value.
  if (pattern.exec(value)?.[0] !== value) return fail();
  return value;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return fail();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return fail();
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as
      PropertyDescriptor | undefined;
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
    captured[key] = descriptor.value as unknown;
  }
  return captured;
}

/** Direct exact-template extraction; not URL normalization or network provenance. */
export function parseProtectedReleaseOrigin(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const match = ORIGIN.exec(value);
  if (match?.[0] !== value || match[1] === undefined) return fail();
  return match[1];
}

/**
 * Pure defensive capture. Live composition must separately capture/recheck the
 * externally configured root, origin, HEAD and trusted expected identity.
 * Historical/offline readers do not call a checkout identity probe.
 */
export function captureProtectedReleaseRepositoryIdentity(
  value: unknown,
): ProtectedReleaseRepositoryIdentity {
  const identity = record(value, [
    'authority_repository_id',
    'expected_release_repository_id',
    'origin_url',
    'repository',
  ]);
  const repository = record(identity['repository'], ['id', 'commit', 'tree']);
  const authority = exactText(identity['authority_repository_id'], SLUG);
  const expected = exactText(identity['expected_release_repository_id'], CANONICAL);
  const id = exactText(repository['id'], CANONICAL);
  const origin = identity['origin_url'];
  if (parseProtectedReleaseOrigin(origin) !== expected || id !== expected) return fail();
  const commit = exactText(repository['commit'], GIT_OBJECT);
  const tree = exactText(repository['tree'], GIT_OBJECT);
  if (commit.length !== tree.length) return fail();
  return Object.freeze({
    authority_repository_id: authority,
    expected_release_repository_id: expected,
    origin_url: origin as string,
    repository: Object.freeze({ id, commit, tree }),
  });
}
