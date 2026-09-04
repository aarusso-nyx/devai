import { describe, expect, it } from 'vitest';
import {
  captureProtectedReleaseRepositoryIdentity,
  parseProtectedReleaseOrigin,
} from '../../src/boundaries/release-repository-identity.js';

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const EXPECTED = 'aarusso-nyx/devai';

function identity(overrides: Record<string, unknown> = {}) {
  return {
    authority_repository_id: 'aarusso-nyx-devai',
    expected_release_repository_id: EXPECTED,
    origin_url: `https://github.com/${EXPECTED}.git`,
    repository: { id: EXPECTED, commit: COMMIT, tree: TREE },
    ...overrides,
  };
}

function refusal(callback: () => unknown): void {
  expect(callback).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}

describe('protected release repository identity', () => {
  it('captures each exact permitted origin form without translating the authority slug', () => {
    const origins = [
      `https://github.com/${EXPECTED}.git`,
      `ssh://git@github.com/${EXPECTED}.git`,
      `git@github.com:${EXPECTED}.git`,
    ];
    for (const origin of origins) {
      expect(parseProtectedReleaseOrigin(origin)).toBe(EXPECTED);
      expect(captureProtectedReleaseRepositoryIdentity(identity({ origin_url: origin }))).toEqual({
        authority_repository_id: 'aarusso-nyx-devai',
        expected_release_repository_id: EXPECTED,
        origin_url: origin,
        repository: { id: EXPECTED, commit: COMMIT, tree: TREE },
      });
    }

    // The policy/session slug and public canonical locator are intentionally
    // distinct domains, even when their text looks related.
    refusal(() =>
      captureProtectedReleaseRepositoryIdentity(identity({ authority_repository_id: EXPECTED })),
    );
    refusal(() =>
      captureProtectedReleaseRepositoryIdentity(
        identity({ expected_release_repository_id: 'aarusso-nyx-devai' }),
      ),
    );
    refusal(() =>
      captureProtectedReleaseRepositoryIdentity(
        identity({ repository: { id: 'aarusso-nyx-devai', commit: COMMIT, tree: TREE } }),
      ),
    );
  });

  it('accepts only matching canonical object formats and exact SHA-1 or SHA-256 pairs', () => {
    expect(
      captureProtectedReleaseRepositoryIdentity(
        identity({ repository: { id: EXPECTED, commit: 'c'.repeat(64), tree: 'd'.repeat(64) } }),
      ).repository,
    ).toEqual({ id: EXPECTED, commit: 'c'.repeat(64), tree: 'd'.repeat(64) });

    const longestOwner = `a${'b'.repeat(37)}a`;
    const longestRepository = `r${'s'.repeat(99)}`;
    const longestCanonical = `${longestOwner}/${longestRepository}`;
    expect(
      captureProtectedReleaseRepositoryIdentity(
        identity({
          expected_release_repository_id: longestCanonical,
          origin_url: `git@github.com:${longestCanonical}.git`,
          repository: { id: longestCanonical, commit: COMMIT, tree: TREE },
        }),
      ).repository.id,
    ).toBe(longestCanonical);

    for (const repository of [
      { id: 'Aarusso-nyx/devai', commit: COMMIT, tree: TREE },
      { id: 'aarusso--nyx/devai', commit: COMMIT, tree: TREE },
      { id: 'aarusso-nyx/devai.git', commit: COMMIT, tree: TREE },
      { id: `${longestOwner}b/${longestRepository}`, commit: COMMIT, tree: TREE },
      { id: `${longestOwner}/${longestRepository}s`, commit: COMMIT, tree: TREE },
      { id: EXPECTED, commit: COMMIT.toUpperCase(), tree: TREE },
      { id: EXPECTED, commit: COMMIT, tree: 'b'.repeat(64) },
    ]) {
      refusal(() => captureProtectedReleaseRepositoryIdentity(identity({ repository })));
    }
  });

  it('refuses every decorated, alternate, or non-exact origin spelling', () => {
    for (const origin of [
      `http://github.com/${EXPECTED}.git`,
      `https://github.com/${EXPECTED}`,
      `https://github.com/${EXPECTED}.git/`,
      `https://github.com/${EXPECTED}.git?query=1`,
      `https://github.com/${EXPECTED}.git#fragment`,
      `https://user@github.com/${EXPECTED}.git`,
      `ssh://user@github.com/${EXPECTED}.git`,
      `ssh://git@github.com:22/${EXPECTED}.git`,
      `git@github.com:${EXPECTED}.git/extra`,
      `git@github.com:${EXPECTED.toUpperCase()}.git`,
      `git@github.com:aarusso-nyx%2fdevai.git`,
      `git@github.com:${EXPECTED}.git\n`,
    ]) {
      refusal(() => parseProtectedReleaseOrigin(origin));
      refusal(() => captureProtectedReleaseRepositoryIdentity(identity({ origin_url: origin })));
    }
    // `.git` is an exact terminal transport suffix, not a replace operation:
    // a repository literally named `devai.git` remains a distinct canonical id.
    const suffixed = `https://github.com/${EXPECTED}.git.git`;
    expect(parseProtectedReleaseOrigin(suffixed)).toBe(`${EXPECTED}.git`);
    refusal(() => captureProtectedReleaseRepositoryIdentity(identity({ origin_url: suffixed })));
  });

  it('rejects non-closed, inherited, proxy, symbol, and accessor controls without invoking them', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, identity());
    expect(captureProtectedReleaseRepositoryIdentity(nullPrototype)).toMatchObject({
      authority_repository_id: 'aarusso-nyx-devai',
      expected_release_repository_id: EXPECTED,
    });

    let outerGetterCalls = 0;
    const accessor = identity();
    Object.defineProperty(accessor, 'origin_url', {
      enumerable: true,
      get() {
        outerGetterCalls += 1;
        return `https://github.com/${EXPECTED}.git`;
      },
    });
    refusal(() => captureProtectedReleaseRepositoryIdentity(accessor));
    expect(outerGetterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const nested = identity({ repository: { id: EXPECTED, commit: COMMIT, tree: TREE } });
    Object.defineProperty(nested.repository, 'commit', {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return COMMIT;
      },
    });
    refusal(() => captureProtectedReleaseRepositoryIdentity(nested));
    expect(nestedGetterCalls).toBe(0);

    const withSymbol = identity();
    Object.defineProperty(withSymbol, Symbol('unexpected'), { enumerable: true, value: true });
    refusal(() => captureProtectedReleaseRepositoryIdentity(withSymbol));
    refusal(() => captureProtectedReleaseRepositoryIdentity({ ...identity(), extra: true }));
    refusal(() => captureProtectedReleaseRepositoryIdentity(Object.create(identity())));

    let proxyTraps = 0;
    const proxied = new Proxy(identity(), {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    refusal(() => captureProtectedReleaseRepositoryIdentity(proxied));
    expect(proxyTraps).toBe(0);
  });
});
