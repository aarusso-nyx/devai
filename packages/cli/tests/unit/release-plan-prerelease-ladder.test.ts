import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveReleaseVerification,
  type ReleaseCapability,
} from '../../src/services/release-profile.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface PrereleaseRung {
  readonly rung: string;
  readonly order: number;
  readonly dist_tag: string;
  readonly required_capabilities: readonly ReleaseCapability[];
}

interface PrereleaseLadder {
  readonly identifier_pattern: string;
  readonly unknown_identifier: string;
  readonly rung_order: readonly string[];
  readonly rungs: readonly PrereleaseRung[];
  readonly stable_dist_tag: string;
  readonly stable_from: string;
}

/** Read the real policy rather than re-declaring the ladder in the test. */
function loadPrereleaseLadder(): PrereleaseLadder {
  const policy = JSON.parse(readFileSync(`${ROOT}law/policy/release-lifecycle.json`, 'utf8')) as {
    readonly plan_determination: { readonly prerelease_ladder: PrereleaseLadder };
  };
  return policy.plan_determination.prerelease_ladder;
}

function rungCapabilities(ladder: PrereleaseLadder, rung: string): readonly ReleaseCapability[] {
  const found = ladder.rungs.find((candidate) => candidate.rung === rung);
  if (found === undefined) throw new Error(`fixture: rung "${rung}" missing from policy`);
  return found.required_capabilities;
}

/**
 * ADR-REL-0028 declares a prerelease ladder (alpha, beta, rc) in
 * law/policy/release-lifecycle.json's plan_determination.prerelease_ladder,
 * plus an optional `channel` field on the release intent
 * (law/schemas/release-intent.schema.json) that must agree with the version
 * string. TASK-0161 landed the policy and schema only; it did not touch
 * packages/cli/src/services/release-profile.ts, the release plan kernel
 * (the TypeScript twin of devai.kernel.release-plan-determination.v3).
 *
 * That kernel still classifies every prerelease transition with generic
 * SemVer 2.0 precedence rules alone: it knows nothing of the ladder's
 * identifier_pattern, its next-rung-only promotion rule, its `channel`
 * field, or its per-rung required_capabilities. Each `it` below is RED
 * unless its comment says the case already holds against today's kernel
 * (a guard on existing behavior the ladder must not change).
 *
 * `channel` is not yet a field of `ReleaseVerificationInput`, so the intent
 * fixtures below are built as plain `const` objects (never inline object
 * literals at the call site) and passed through untyped -- this keeps
 * `channel` present for the kernel to (eventually) read without an excess
 * -property compile error, and without editing the source interface.
 */
describe('release plan kernel: prerelease channel ladder (ADR-REL-0028)', () => {
  const ladder = loadPrereleaseLadder();

  it('RED (IA-001): blocks a prerelease identifier outside the ladder with invalid-semver precedence', () => {
    // '1.6.0-nightly.1' is valid generic SemVer, so today's kernel treats it
    // as an ordinary prerelease bump and returns 'ready'. The ladder's
    // identifier_pattern (^(alpha|beta|rc)\.(0|[1-9][0-9]*)$) says "nightly"
    // is not a rung at all, and unknown_identifier: "invalid-semver" says
    // this must block with the same precedence as a malformed version,
    // never be defaulted to a rung.
    const input = {
      currentVersion: '1.5.0',
      targetVersion: '1.6.0-nightly.1',
      support: 'preview' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('block');
    expect(result.blockingReasons).toEqual(['invalid-semver']);
    expect(result.capabilities).toEqual([]);
  });

  it('GREEN (guard): a same-rung suffix increment (alpha.1 -> alpha.2) still passes', () => {
    // Generic SemVer prerelease ordering already accepts this, and the
    // ladder's same-rung-suffix-increment rule agrees, so this must keep
    // passing once the ladder is enforced.
    const input = {
      currentVersion: '1.6.0-alpha.1',
      targetVersion: '1.6.0-alpha.2',
      support: 'preview' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('ready');
    expect(result.transition).toBe('prerelease');
  });

  it('GREEN (guard): rc after beta blocks as a downgrade, same as generic SemVer ordering', () => {
    // 'beta' < 'rc' both alphabetically and along the ladder, so today's
    // generic prerelease comparison already blocks this -- the ladder's
    // "any other movement is a downgrade" rule must not weaken it.
    const input = {
      currentVersion: '1.6.0-rc.1',
      targetVersion: '1.6.0-beta.1',
      support: 'preview' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('block');
    expect(result.blockingReasons).toEqual(['downgrade']);
    expect(result.capabilities).toEqual([]);
  });

  it('RED (IA-002): blocks a promotion that skips a rung, even though it reads as a SemVer advance', () => {
    // 'alpha' < 'rc' alphabetically, so today's generic comparison treats
    // 1.6.0-alpha.1 -> 1.6.0-rc.1 as a forward move and returns 'ready'.
    // The ladder's forward-along-ladder rule allows only the *next* rung in
    // rung_order; skipping "beta" is a downgrade under "otherwise: downgrade".
    const input = {
      currentVersion: '1.6.0-alpha.1',
      targetVersion: '1.6.0-rc.1',
      support: 'preview' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('block');
    expect(result.blockingReasons).toEqual(['downgrade']);
    expect(result.capabilities).toEqual([]);
  });

  it('RED: blocks a stable version promoted from a non-rc rung', () => {
    // Generic SemVer precedence ranks any prerelease below its bare release,
    // so today's kernel treats 1.6.0-beta.3 -> 1.6.0 as an ordinary forward
    // prerelease bump and returns 'ready'. The policy's stable_from: "rc"
    // says only the rc rung may promote to stable; every other rung must
    // fall through to "otherwise: downgrade".
    const input = {
      currentVersion: '1.6.0-beta.3',
      targetVersion: '1.6.0',
      support: 'current' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('block');
    expect(result.blockingReasons).toEqual(['downgrade']);
    expect(result.capabilities).toEqual([]);
  });

  it('passes stable-from-rc, but a RED gap remains: it must require the full rc capability closure', () => {
    // The plan itself already passes today (guard: stable_from: "rc" is the
    // one promotion the generic comparison already gets right). But the
    // kernel's 'prerelease' transition capability set (affected-checks,
    // dependent-checks, build-integrity) is far short of the policy's rc
    // rung, which requires the complete RC coverage closure (e2e, consumer,
    // api-compatibility, migration, rollback, adopter-materialization,
    // security, database, tenancy, provenance, reproducibility, unit,
    // integration, plus the floor). Promoting stable from rc must carry
    // that whole closure, per ADR-REL-0028's "rc ... is the only rung from
    // which a stable version may be promoted" and its required depth.
    const input = {
      currentVersion: '1.6.0-rc.1',
      targetVersion: '1.6.0',
      support: 'current' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('ready');
    expect(result.capabilities).toEqual(
      expect.arrayContaining([...rungCapabilities(ladder, 'rc')]),
    );
  });

  it('passes a beta suffix increment, but a RED gap remains: it must require the beta capability closure', () => {
    // The plan itself already passes today (generic prerelease ordering
    // agrees with same-rung-suffix-increment). But beta's required_capabilities
    // add the full unit and integration closure on top of the floor
    // (ADR-REL-0028: "Beta adds the full unit and integration closure"),
    // and the kernel's flat 'prerelease' transition capability set has
    // neither 'unit' nor 'integration'.
    const input = {
      currentVersion: '1.6.0-beta.1',
      targetVersion: '1.6.0-beta.2',
      support: 'preview' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('ready');
    expect(result.capabilities).toEqual(
      expect.arrayContaining([...rungCapabilities(ladder, 'beta')]),
    );
  });

  it('RED (IA-003): blocks when the declared channel disagrees with the target version', () => {
    // `channel` is a new, optional field on the release intent
    // (law/schemas/release-intent.schema.json) that the kernel does not
    // read at all today, so this extra property is silently ignored and
    // the plan resolves 'ready'. ADR-REL-0028's consequence section says
    // "the kernel blocks when the field and the version disagree" --
    // 1.6.0-alpha.1 names the alpha rung, and a declared channel of "beta"
    // must not be allowed to pass.
    const input = {
      currentVersion: '1.5.0',
      targetVersion: '1.6.0-alpha.1',
      support: 'preview' as const,
      channel: 'beta' as const,
    };
    const result = resolveReleaseVerification(input);
    expect(result.verdict).toBe('block');
    expect(result.capabilities).toEqual([]);
  });
});
