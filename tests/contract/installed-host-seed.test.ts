import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { inspectInstalledHostSeed, runInstalledExportCommand } = await import(
  pathToFileURL(resolve('scripts/process/installed-export-command.mjs')).href
);
const roots: string[] = [];
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'installed seed ação-')));
  roots.push(parent);
  const root = join(parent, 'seed'),
    candidateRoot = join(parent, 'candidate');
  mkdirSync(candidateRoot);
  mkdirSync(root);
  mkdirSync(join(root, 'host'));
  mkdirSync(join(root, 'index'));
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'host/provision-package.mjs': 'throw new Error("inspection must never execute this module");\n',
    'index/release-host-bootstrap.js':
      'throw new Error("inspection must never execute this module");\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const members = Object.fromEntries(
    Object.keys(files).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(root, name)))
        .digest('hex'),
    ]),
  );
  return { root, candidateRoot, members };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('inspects a complete pinned seed without executing its code', () => {
  const f = fixture();
  expect(inspectInstalledHostSeed(f)).toBe(join(f.root, 'host/provision-package.mjs'));
});
it.each(['package.json', 'host/provision-package.mjs', 'index/release-host-bootstrap.js'])(
  'refuses changed approved seed bytes: %s',
  (name) => {
    const f = fixture();
    writeFileSync(join(f.root, name), 'changed');
    expect(() => inspectInstalledHostSeed(f)).toThrow('INSTALLED_HOST_SEED_DIGEST_MISMATCH');
  },
);
it.each(['missing', 'extra', 'empty directory', 'symlink'])(
  'refuses a changed seed population: %s',
  (kind) => {
    const f = fixture();
    if (kind === 'missing') rmSync(join(f.root, 'host/provision-package.mjs'));
    if (kind === 'extra') writeFileSync(join(f.root, 'index/extra.js'), '');
    if (kind === 'empty directory') mkdirSync(join(f.root, 'extra'));
    if (kind === 'symlink') {
      rmSync(join(f.root, 'host/provision-package.mjs'));
      symlinkSync('../index/release-host-bootstrap.js', join(f.root, 'host/provision-package.mjs'));
    }
    expect(() => inspectInstalledHostSeed(f)).toThrow('INSTALLED_HOST_SEED_POPULATION_INVALID');
  },
);
it('refuses seed code inside the candidate', () => {
  const f = fixture();
  expect(() => inspectInstalledHostSeed({ ...f, candidateRoot: f.root })).toThrow(
    'INSTALLED_HOST_SEED_LOCATION_INVALID',
  );
});
it('requires complete external pins before reading seed code', () => {
  expect(() =>
    inspectInstalledHostSeed({ root: '/absent', candidateRoot: '/absent', members: {} }),
  ).toThrow('INSTALLED_HOST_SEED_PINS_REQUIRED');
});

it.each([
  ['missing path', 'INSTALLED_OFFLINE_PLAN_FILE_INVALID'],
  ['wrong digest', 'MUTATION_INPUT_PLAN_DIGEST_MISMATCH'],
  ['wrong candidate', 'MUTATION_INPUT_PLAN_CANDIDATE_MISMATCH'],
  ['incomplete roster', 'MUTATION_INPUT_PLAN_ROSTER_MISMATCH'],
])('rejects %s before executing any host bootstrap module', async (kind, error) => {
  const seed = fixture();
  const repository = { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const plan = {
    repository: kind === 'wrong candidate' ? { ...repository, commit: 'c'.repeat(40) } : repository,
    release_unit: '@aarusso-nyx/devai',
    mutation_policy_digest: 'd'.repeat(64),
    release_plan_receipt_digest: 'e'.repeat(64),
    release_profile_digest: 'f'.repeat(64),
    packages: [],
  };
  const path = join(seed.candidateRoot, 'plan.json');
  const bytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(path, bytes);
  await expect(
    runInstalledExportCommand({
      seed,
      mutationInputPlanPath: kind === 'missing path' ? undefined : path,
      verification: {
        dagControl: { candidateRoot: seed.candidateRoot },
        expected: {
          repository,
          mutationPlanSha256:
            kind === 'wrong digest'
              ? '0'.repeat(64)
              : createHash('sha256').update(bytes).digest('hex'),
        },
      },
    }),
  ).rejects.toThrow(error);
});
