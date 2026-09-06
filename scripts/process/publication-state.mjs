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
const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
if (result.status !== 0) throw new Error('PUBLICATION_STATE_UNKNOWN');
const value = JSON.parse(result.stdout);
if (!Array.isArray(value)) throw new Error('PUBLICATION_STATE_UNKNOWN');
const found =
  kind === 'release'
    ? value.flat().some((release) => release.tag_name === identity)
    : value.includes(identity);
process.stdout.write(found ? 'present\n' : 'absent\n');
