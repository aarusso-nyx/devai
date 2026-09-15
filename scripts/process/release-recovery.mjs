#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function population(directory) {
  const result = new Map();
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || !lstatSync(path).isFile())
      throw new Error('RELEASE_RECOVERY_UNSAFE_ASSET');
    result.set(name, createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return result;
}

/** Observe the complete downloaded population before authorizing any missing upload. */
export function missingReleaseAssets(expectedDirectory, observedDirectory, state) {
  if (!['draft', 'present'].includes(state)) throw new Error('RELEASE_RECOVERY_STATE_UNKNOWN');
  const expected = population(expectedDirectory);
  const observed = population(observedDirectory);
  if (expected.size === 0) throw new Error('RELEASE_RECOVERY_EXPECTED_EMPTY');
  for (const [name, digest] of observed) {
    if (expected.get(name) !== digest) throw new Error('RELEASE_RECOVERY_ASSET_MISMATCH');
  }
  const missing = [...expected.keys()].filter((name) => !observed.has(name));
  if (state === 'present' && missing.length !== 0)
    throw new Error('RELEASE_RECOVERY_PUBLISHED_INCOMPLETE');
  return missing;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  if (process.argv.length !== 5) throw new Error('RELEASE_RECOVERY_USAGE');
  const missing = missingReleaseAssets(...process.argv.slice(2));
  if (missing.length) process.stdout.write(`${missing.join('\n')}\n`);
}
