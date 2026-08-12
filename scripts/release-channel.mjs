#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function releaseChannel(version) {
  if (typeof version !== 'string' || version === '') {
    throw new Error('RELEASE_VERSION_MISSING');
  }
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`RELEASE_VERSION_INVALID:${version}`);
  const prerelease = match[1] !== undefined;
  return {
    schemaVersion: '1.0.0',
    version,
    prerelease,
    release_type: prerelease ? 'prerelease' : 'stable',
    dist_tag: prerelease ? 'next' : 'latest',
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(releaseChannel(process.argv[2]))}\n`);
}
