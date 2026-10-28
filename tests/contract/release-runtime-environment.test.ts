import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const { certificationEnvironment, certifyCandidate, candidateResultsDirectory } = await import(
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

it.each([
  ['reused', 'PASS', 'RC_COVERAGE_NOT_FRESH_PASS'],
  ['executed', 'FAIL', 'RC_COVERAGE_NOT_FRESH_PASS'],
  ['missing', 'PASS', 'RC_COVERAGE_DISPOSITION_INVALID'],
])(
  'rejects coverage disposition %s/%s before returning an exportable receipt',
  (disposition, outcome, error) => {
    const f = fixture();
    const packageRoot = join(f.config.repo, '..', 'package');
    const runnerPath = join(f.config.repo, 'scripts/process/validation-runner.mjs');
    const hostPath = join(packageRoot, 'dist/runtime/index/devai-rc-certification.js');
    mkdirSync(join(f.config.repo, 'scripts/process'), { recursive: true });
    mkdirSync(join(packageRoot, 'dist/runtime/index'), { recursive: true });
    writeFileSync(
      runnerPath,
      `import { spawnSync } from 'node:child_process';
const r = spawnSync(process.argv[4], process.argv.slice(5), { encoding: 'utf8' });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status;
`,
    );
    const execution =
      disposition === 'missing' ? [] : [{ nodeId: 'test:coverage:rc', disposition, outcome }];
    writeFileSync(
      hostPath,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ exitCode: 0, receipt: { path: 'receipt.json' }, execution }))});
`,
    );
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => certifyCandidate({ ...f.config, packageRoot }, f.descriptor)).toThrow(error);
      expect(log.mock.calls.map((call) => String(call[0])).join('')).toContain('rc-invocation');
    } finally {
      log.mockRestore();
    }
  },
);

it('binds an isolated receipt to its own results and preserves the legacy location', () => {
  const f = fixture();
  const base = join(realpathSync(f.config.repo), '.devai/state/check-cache/v1');
  const aliasBase = join(f.config.repo, '.devai/state/check-cache/v1');
  const cache = join(base, 'rc-certification-12345678-1234-4123-8123-123456789abc');
  const receipt = join(cache, 'receipts', `${'a'.repeat(64)}.json`);
  mkdirSync(join(cache, 'receipts'), { recursive: true });
  mkdirSync(join(cache, 'results'));
  writeFileSync(receipt, '{}');
  const aliasReceipt = receipt.replace(base, aliasBase);
  expect(candidateResultsDirectory(f.config.repo, aliasReceipt)).toBe(join(cache, 'results'));
  expect(candidateResultsDirectory(f.config.repo, join(base, 'receipts', 'legacy.json'))).toBe(
    join(base, 'results'),
  );
  expect(() =>
    candidateResultsDirectory(f.config.repo, join(cache, 'receipts', 'invalid.json')),
  ).toThrow('RC_CACHE_INVALID');
  rmSync(join(cache, 'results'), { recursive: true });
  symlinkSync(join(base, 'outside'), join(cache, 'results'));
  mkdirSync(join(base, 'outside'));
  expect(() => candidateResultsDirectory(f.config.repo, receipt)).toThrow('RC_CACHE_INVALID');
});
