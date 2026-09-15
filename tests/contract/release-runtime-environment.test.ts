import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { certificationEnvironment } = await import(
  pathToFileURL(resolve('scripts/process/release-prerequisites.mjs')).href
);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai runtime environment ç '));
  roots.push(root);
  const repo = join(root, 'candidate');
  mkdirSync(repo);
  const config = {
    repo,
    environment: join(root, 'identities.json'),
    runtimeEnvironment: join(root, 'runtime.json'),
  };
  const write = (values: unknown, identities: unknown) => {
    writeFileSync(config.runtimeEnvironment, JSON.stringify(values), { mode: 0o600 });
    writeFileSync(config.environment, JSON.stringify(identities), { mode: 0o600 });
  };
  write(
    { DATABASE_URL: 'private value ç', UNSELECTED_SECRET: 'never forwarded' },
    { DATABASE_URL: hash('private value ç'), OPTIONAL: null },
  );
  const descriptor = {
    profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['test'] }],
    tasks: [
      { nodeId: 'test', dependencies: ['build'], allowlistedEnv: ['OPTIONAL'] },
      { nodeId: 'build', dependencies: [], allowlistedEnv: ['DATABASE_URL'] },
      { nodeId: 'mutation', dependencies: [], allowlistedEnv: ['MUTATION_TOKEN'] },
    ],
  };
  return { config, descriptor, write };
}
it('passes raw values only after verifying selected RC and dependency hashes, without requiring unselected mutation inputs', () => {
  const f = fixture();
  const result = certificationEnvironment(f.config, f.descriptor);
  expect(result.DATABASE_URL).toBe('private value ç');
  expect(result.OPTIONAL).toBeUndefined();
  expect(result.MUTATION_TOKEN).toBeUndefined();
  expect(result.UNSELECTED_SECRET).toBeUndefined();
});
it.each([
  [
    { DATABASE_URL: 'wrong private value' },
    { DATABASE_URL: hash('private value ç'), OPTIONAL: null },
  ],
  [{}, { DATABASE_URL: hash('private value ç'), OPTIONAL: null }],
  [{ DATABASE_URL: 123 }, { DATABASE_URL: hash('123'), OPTIONAL: null }],
  [
    { DATABASE_URL: 'private value ç', OPTIONAL: 'unexpected' },
    { DATABASE_URL: hash('private value ç'), OPTIONAL: null },
  ],
  [{ DATABASE_URL: 'private value ç' }, { OPTIONAL: null }],
  [{ DATABASE_URL: 'private value ç' }, { DATABASE_URL: 'private value ç', OPTIONAL: null }],
])(
  'rejects mismatched or absent identities without exposing runtime values',
  (values, identities) => {
    const f = fixture();
    f.write(values, identities);
    expect(() => certificationEnvironment(f.config, f.descriptor)).toThrow(
      /^RUNTIME_ENVIRONMENT_IDENTITY_(?:MISMATCH|INVALID)$/u,
    );
  },
);
it('requires a separate explicit private external runtime file', () => {
  const f = fixture();
  expect(() =>
    certificationEnvironment({ ...f.config, runtimeEnvironment: undefined }, f.descriptor),
  ).toThrow('RUNTIME_ENVIRONMENT_REQUIRED');
  chmodSync(f.config.runtimeEnvironment, 0o644);
  expect(() => certificationEnvironment(f.config, f.descriptor)).toThrow(
    'RUNTIME_ENVIRONMENT_FILE_INVALID',
  );
  chmodSync(f.config.runtimeEnvironment, 0o600);
  const linked = join(resolve(f.config.repo, '..'), 'linked.json');
  symlinkSync(f.config.runtimeEnvironment, linked);
  expect(() =>
    certificationEnvironment({ ...f.config, runtimeEnvironment: linked }, f.descriptor),
  ).toThrow('RUNTIME_ENVIRONMENT_FILE_INVALID');
  const internal = join(f.config.repo, 'runtime.json');
  writeFileSync(internal, '{}', { mode: 0o600 });
  expect(() =>
    certificationEnvironment({ ...f.config, runtimeEnvironment: internal }, f.descriptor),
  ).toThrow('PROTECTED_INPUT_INSIDE_CANDIDATE');
});
it('rejects an ambiguous or cyclic RC selection', () => {
  const f = fixture();
  expect(() => certificationEnvironment(f.config, { ...f.descriptor, profiles: [] })).toThrow(
    'RC_PROFILE_INVALID',
  );
  const build = f.descriptor.tasks[1];
  if (build === undefined) throw new Error('missing fixture build');
  build.dependencies.push('test');
  expect(() => certificationEnvironment(f.config, f.descriptor)).toThrow(
    'RC_TASK_DEPENDENCY_INVALID',
  );
});

it('redacts malformed private JSON diagnostics', () => {
  const f = fixture();
  writeFileSync(f.config.runtimeEnvironment, '{private-secret-invalid-json');
  expect(() => certificationEnvironment(f.config, f.descriptor)).toThrow(
    /^RUNTIME_ENVIRONMENT_MAP_INVALID$/u,
  );
});
