#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const LIFECYCLE_POLICY = new URL('../law/policy/release-lifecycle.json', import.meta.url);

/** Read the prerelease ladder declared by ADR-REL-0028 from the lifecycle policy. */
function prereleaseLadder() {
  const policy = JSON.parse(readFileSync(LIFECYCLE_POLICY, 'utf8'));
  const ladder = policy.plan_determination?.prerelease_ladder;
  if (
    ladder === undefined ||
    typeof ladder.identifier_pattern !== 'string' ||
    !Array.isArray(ladder.rungs) ||
    typeof ladder.stable_dist_tag !== 'string'
  ) {
    throw new Error('RELEASE_CHANNEL_POLICY_INVALID');
  }
  return ladder;
}

export function releaseChannel(version) {
  if (typeof version !== 'string' || version === '') {
    throw new Error('RELEASE_VERSION_MISSING');
  }
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`RELEASE_VERSION_INVALID:${version}`);
  const ladder = prereleaseLadder();
  const identifier = match[1];
  const prerelease = identifier !== undefined;
  let channel = 'stable';
  let distTag = ladder.stable_dist_tag;
  if (prerelease) {
    const rungMatch = new RegExp(ladder.identifier_pattern, 'u').exec(identifier);
    const rung = ladder.rungs.find((candidate) => candidate.rung === rungMatch?.[1]);
    if (rungMatch === null || rung === undefined) {
      throw new Error(`RELEASE_VERSION_INVALID:${version}`);
    }
    channel = rung.rung;
    distTag = rung.dist_tag;
  }
  if (prerelease === (distTag === ladder.stable_dist_tag)) {
    throw new Error(`RELEASE_CHANNEL_DIST_TAG_INVALID:${version}`);
  }
  return {
    schemaVersion: '1.0.0',
    version,
    prerelease,
    release_type: prerelease ? 'prerelease' : 'stable',
    channel,
    dist_tag: distTag,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(releaseChannel(process.argv[2]))}\n`);
}
