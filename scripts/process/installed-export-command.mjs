#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyInstalledExport } from './verify-installed-export.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const loadedSeeds = new Map();
const seedMembers = [
  'package.json',
  'host/provision-package.mjs',
  'index/release-host-bootstrap.js',
];

/** Pins are supplied by protected operator configuration, outside evidence transport.
 * This minimal seed loads only the approved provisioner and bundled bootstrap.
 * The provisioner verifies the full approved archive before loading its runtime. */
export function inspectInstalledHostSeed({ root, candidateRoot, members }) {
  requireValue(
    members &&
      JSON.stringify(Object.keys(members).sort()) === JSON.stringify([...seedMembers].sort()),
    'INSTALLED_HOST_SEED_PINS_REQUIRED',
  );
  const directory = realpathSync(root);
  const candidate = realpathSync(candidateRoot);
  const rel = relative(candidate, directory);
  requireValue(
    directory === resolve(root) && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
    'INSTALLED_HOST_SEED_LOCATION_INVALID',
  );
  const found = [];
  function visit(path, depth) {
    requireValue(
      depth <= 1 && lstatSync(path).isDirectory(),
      'INSTALLED_HOST_SEED_POPULATION_INVALID',
    );
    for (const name of readdirSync(path)) {
      const file = join(path, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) {
        requireValue(
          depth === 0 && ['host', 'index'].includes(name),
          'INSTALLED_HOST_SEED_POPULATION_INVALID',
        );
        visit(file, depth + 1);
      } else {
        const member = relative(directory, file).split(sep).join('/');
        requireValue(
          stat.isFile() &&
            stat.nlink === 1 &&
            seedMembers.includes(member) &&
            stat.size <= 32 * 1024 * 1024 &&
            /^[a-f0-9]{64}$/u.test(members[member]),
          'INSTALLED_HOST_SEED_POPULATION_INVALID',
        );
        requireValue(
          sha(readFileSync(file)) === members[member],
          'INSTALLED_HOST_SEED_DIGEST_MISMATCH',
        );
        found.push(member);
      }
    }
  }
  visit(directory, 0);
  requireValue(found.length === seedMembers.length, 'INSTALLED_HOST_SEED_POPULATION_INVALID');
  requireValue(
    readFileSync(join(directory, 'package.json'), 'utf8') === '{"type":"module"}\n',
    'INSTALLED_HOST_SEED_PACKAGE_INVALID',
  );
  return join(directory, 'host/provision-package.mjs');
}

export async function runInstalledExportCommand(config) {
  const provisioner = inspectInstalledHostSeed(config.seed);
  const identity = seedMembers.map((name) => config.seed.members[name]).join(':');
  requireValue(
    !loadedSeeds.has(provisioner) || loadedSeeds.get(provisioner) === identity,
    'INSTALLED_HOST_SEED_PROCESS_CHANGED',
  );
  loadedSeeds.set(provisioner, identity);
  requireValue(
    config.seed.candidateRoot === config.verification.dagControl.candidateRoot,
    'INSTALLED_HOST_CANDIDATE_ROOT_MISMATCH',
  );
  const expected = { ...config.verification.expected };
  const { provisionReleaseHostPackage } = await import(pathToFileURL(provisioner).href);
  inspectInstalledHostSeed(config.seed);
  const { host } = await provisionReleaseHostPackage(config.provision);
  return verifyInstalledExport({ ...config.verification, expected, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 3, 'INSTALLED_OFFLINE_CONFIG_REQUIRED');
    const path = process.argv[2];
    const stat = lstatSync(path);
    requireValue(
      stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 1024 * 1024,
      'INSTALLED_OFFLINE_CONFIG_INVALID',
    );
    const result = await runInstalledExportCommand(JSON.parse(readFileSync(path, 'utf8')));
    console.log(
      JSON.stringify({
        verdict: result.receipt.verdict,
        receipt_id: result.receipt.receipt_id,
        receipt_digest_sha256: result.receipt.receipt_digest_sha256,
      }),
    );
  } catch {
    // Private evidence and protected configuration never enter public logs.
    process.stderr.write(
      'Installed export verification failed; retain private work for diagnosis.\n',
    );
    process.exitCode = 1;
  }
}
