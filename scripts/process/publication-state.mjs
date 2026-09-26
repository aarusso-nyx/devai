#!/usr/bin/env node
// Query the collection successfully before concluding that an effect is absent.
// A failed authentication/network/read is UNKNOWN and must never trigger a write.
import { spawnSync } from 'node:child_process';
const [kind, identity] = process.argv.slice(2);
const args =
  kind === 'release'
    ? ['gh', 'api', '--paginate', '--slurp', 'repos/aarusso-nyx/devai/releases?per_page=100']
    : kind === 'registry'
      ? [
          'npm',
          'view',
          '@aarusso-nyx/devai',
          'versions',
          '--json',
          '--registry',
          'https://npm.pkg.github.com',
        ]
      : null;
if (!args || !identity) throw new Error('PUBLICATION_STATE_USAGE');
// The release collection already exceeds Node's default 1 MiB spawn buffer; a truncated
// read terminates the child and must surface as UNKNOWN, never as absence.
const result = spawnSync(args[0], args.slice(1), {
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
if (result.status !== 0) {
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error('PUBLICATION_STATE_UNKNOWN');
}
const value = JSON.parse(result.stdout);
if (!Array.isArray(value)) throw new Error('PUBLICATION_STATE_UNKNOWN');
if (kind === 'release') {
  if (
    value.some(
      (page) =>
        !Array.isArray(page) ||
        page.some(
          (release) =>
            release === null ||
            typeof release !== 'object' ||
            typeof release.tag_name !== 'string' ||
            release.tag_name.length === 0 ||
            typeof release.draft !== 'boolean',
        ),
    )
  )
    throw new Error('PUBLICATION_STATE_UNKNOWN');
  const releases = value.flat();
  if (new Set(releases.map((release) => release.tag_name)).size !== releases.length)
    throw new Error('PUBLICATION_STATE_UNKNOWN');
  const found = releases.find((release) => release.tag_name === identity);
  process.stdout.write(found ? (found.draft ? 'draft\n' : 'present\n') : 'absent\n');
} else {
  if (
    value.some((version) => typeof version !== 'string' || !/^\S+$/u.test(version)) ||
    new Set(value).size !== value.length
  )
    throw new Error('PUBLICATION_STATE_UNKNOWN');
  process.stdout.write(value.includes(identity) ? 'present\n' : 'absent\n');
}
