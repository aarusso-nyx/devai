import { describe, expect, it } from 'vitest';

interface ReleaseChannelResult {
  readonly schemaVersion: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly release_type: 'prerelease' | 'stable';
  readonly dist_tag: string;
  readonly channel?: string;
}

type ReleaseChannelModule = Readonly<{
  releaseChannel: (version: string) => ReleaseChannelResult;
}>;

// Dynamic file-URL import, per the existing convention in
// packages/cli/tests/unit/npm-pack-output.test.ts, which imports another
// scripts/*.mjs the same way; that file also confirms vitest and the
// project's TypeScript config already support a top-level typed-cast import
// of a plain .mjs script from a .test.ts file.
const { releaseChannel } = (await import(
  new URL('../../scripts/release-channel.mjs', import.meta.url).href
)) as ReleaseChannelModule;

/**
 * ADR-REL-0028 declares a prerelease ladder (alpha, beta, rc) with per-rung
 * dist-tags (alpha, beta, next) and a stable dist-tag of latest
 * (law/policy/release-lifecycle.json's plan_determination.prerelease_ladder),
 * and an intent-facing `channel` derived from the version
 * (law/schemas/release-intent.schema.json). TASK-0161 landed only the policy
 * and schema; scripts/release-channel.mjs is untouched. Today it recognizes
 * exactly two outcomes -- "prerelease" -> dist_tag "next" and "stable" ->
 * dist_tag "latest" -- and never emits a `channel` field at all, and its
 * SemVer regex accepts any syntactically valid prerelease identifier
 * (including ones outside the ladder, like "nightly"). Each `it` below is
 * RED unless its comment says otherwise.
 */
describe('release channel ladder (ADR-REL-0028)', () => {
  it('RED: maps 1.6.0-alpha.1 to the alpha dist-tag and channel', () => {
    // Today: dist_tag is "next" (the flat prerelease case) and there is no
    // `channel` field at all.
    expect(releaseChannel('1.6.0-alpha.1')).toMatchObject({ dist_tag: 'alpha', channel: 'alpha' });
  });

  it('RED: maps 1.6.0-beta.2 to the beta dist-tag and channel', () => {
    // Today: dist_tag is "next"; no `channel` field.
    expect(releaseChannel('1.6.0-beta.2')).toMatchObject({ dist_tag: 'beta', channel: 'beta' });
  });

  it('RED: maps 1.6.0-rc.1 to the next dist-tag with an rc channel', () => {
    // dist_tag "next" already holds by coincidence (rc is the only rung
    // sharing today's one flat prerelease dist-tag), but `channel` is still
    // entirely missing, so this case is red on the `channel` assertion.
    expect(releaseChannel('1.6.0-rc.1')).toMatchObject({ dist_tag: 'next', channel: 'rc' });
  });

  it('RED: maps a stable version to latest with a stable channel', () => {
    // dist_tag "latest" already holds; `channel` is still missing.
    expect(releaseChannel('1.6.0')).toMatchObject({ dist_tag: 'latest', channel: 'stable' });
  });

  it('GREEN (guard): an alpha prerelease never resolves to the latest dist-tag', () => {
    // Already true today: any prerelease currently maps to "next", never
    // "latest". The ladder must preserve this invariant even though alpha
    // gets its own "alpha" dist-tag instead of "next".
    expect(releaseChannel('1.6.0-alpha.1').dist_tag).not.toBe('latest');
  });

  it('RED: refuses a prerelease identifier outside the declared ladder', () => {
    // "nightly.1" is valid generic SemVer, so today's SEMVER regex accepts
    // it and releaseChannel returns a "next" dist-tag instead of throwing.
    // The ladder's identifier_pattern (alpha|beta|rc only) means this must
    // be refused the same way an already-invalid version is.
    expect(() => releaseChannel('1.6.0-nightly.1')).toThrow(/RELEASE_VERSION_INVALID/);
  });
});
