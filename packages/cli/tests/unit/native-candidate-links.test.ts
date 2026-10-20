// Independent Inspector acceptance: tracked unconsumed link metadata, not alias read permission.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, aroundEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { readCandidateFile } from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { runWithResolvedSensorMember } from '../../src/authority/sensor-member.js';
import {
  executeSensorTask,
  attestNativeTaskExecution,
  matchDeclaredSensorTaskProcess,
  resolveSensorTaskBinding,
  type SensorTaskBinding,
} from '../../src/commands/sense/task-binding.js';
import { resolveSensorReadingInstance } from '../../src/commands/sense/reading-instance.js';
import { deriveNativeLinuxTask } from '../../src/commands/sense/native-linux-plan.js';
import { installNativeVitest } from '../fixtures/native-test-results/native-runner-fixture.js';

// Call-through observation seams permit real filesystem races, never authored metadata/results.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readlinkSync: vi.fn(actual.readlinkSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const alias = 'apps/rait/web/src/app/preview/fixtures';
const literal = '../../../../../../docs/fixtures';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.readlinkSync).mockImplementation(actual.readlinkSync);
  vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function put(root: string, path: string, value: string | object) {
  const target = join(root, path);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Independent Inspector',
      '-c',
      'user.email=inspector@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fileMode=true',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}
function commit(root: string, message = 'fixture snapshot') {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
}
function tracked(root: string) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) => !['.devai/state/', 'record/', 'scratch/'].some((prefix) => path.startsWith(prefix)),
    );
}
function replaceLink(root: string, target: string, path = alias) {
  fs.rmSync(join(root, path), { recursive: true, force: true });
  fs.mkdirSync(dirname(join(root, path)), { recursive: true });
  fs.symlinkSync(target, join(root, path), 'dir');
}
function fixture(withLink = true) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'devai-native-links-')));
  roots.push(root);
  put(root, '.gitignore', 'node_modules/\n.devai/state/\nrecord/\nscratch/\n*.ignored\n');
  put(root, 'package.json', { private: true, type: 'module' });
  put(root, 'docs/fixtures/one.json', '{"fixture":1}\n');
  put(root, 'docs/fixtures/two.json', '{"fixture":2}\n');
  put(root, 'src/regular.txt', 'ordinary candidate input\n');
  if (withLink) replaceLink(root, literal);
  git(root, 'init', '-q', '-b', 'main');
  commit(root);
  return root;
}
function nativeFixture() {
  const root = fixture();
  const file = 'backend/tests/one.test.ts';
  const project = 'link-fixture';
  put(root, 'backend/package.json', { private: true, type: 'module' });
  put(root, file, "import {it,expect} from 'vitest'; it('passes',()=>expect(2+2).toBe(4));\n");
  put(
    root,
    'vitest.config.mjs',
    "export default {root:'./backend',test:{name:'link-fixture',include:['**/*.test.ts'],pool:'forks',maxWorkers:1,watch:false,coverage:{enabled:false}}};\n",
  );
  put(root, 'package.json', {
    private: true,
    type: 'module',
    devDependencies: {
      vitest: '4.1.11',
      vite: '7.3.6',
      '@aarusso-nyx/devai': JSON.parse(
        fs.readFileSync(join(repositoryRoot, 'packages/cli/package.json'), 'utf8'),
      ).version,
    },
  });
  put(root, 'test-tasks.json', {
    schemaVersion: '1.0.0',
    descriptorVersion: 'link-fixture-v1',
    repositoryId: 'link-fixture',
    fallbackNodeId: 'native',
    dynamicFallbackSelectors: [],
    profiles: [],
    tasks: [
      {
        nodeId: 'native',
        sensorKinds: ['unit_test'],
        dependencies: [],
        cwd: '.',
        runner: 'exec-v1',
        argv: [
          'vitest',
          'run',
          '--configLoader',
          'native',
          '--config',
          './vitest.config.mjs',
          '--reporter',
          '@aarusso-nyx/devai/native-vitest-reporter',
          '--no-cache',
        ],
        inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
        toolchainKeys: [],
        allowlistedEnv: [],
        outputContract: {
          kind: 'command-result',
          population: 'link-fixture',
          resultPopulation: {
            schemaVersion: '1.0.0',
            format: 'vitest-json',
            projectId: project,
            selectionEvidence: {
              kind: 'devai-native-collection',
              reporter: 'vitest-v1',
              projectName: project,
            },
            transport: { kind: 'direct' },
            executableFiles: [file],
            requiredTestIds: [
              `test:v1:${encodeURIComponent(JSON.stringify([project, file, [], 'passes']))}`,
            ],
          },
        },
      },
    ],
  });
  installNativeVitest(repositoryRoot, root);
  fs.mkdirSync(join(root, 'node_modules/@aarusso-nyx'), { recursive: true });
  fs.symlinkSync(
    join(repositoryRoot, 'packages/cli'),
    join(root, 'node_modules/@aarusso-nyx/devai'),
    'dir',
  );
  commit(root, 'native backend collection with unconsumed preview alias');
  return root;
}
function binding(root: string) {
  const result = resolveSensorTaskBinding(root, 'unit_test', {
    taskId: 'native',
    population: 'link-fixture',
  });
  if (result === undefined) throw new Error('Expected native binding');
  return result;
}
function executeReal(bound: SensorTaskBinding) {
  let starts = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'independent-link-inspector',
    issuer_version: '1.0.0',
    invocation_id: 'native-link-test',
    canonicalSha256: () => 'a'.repeat(64),
    randomId: () => 'native-link-test',
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense run',
    invocation_id: 'native-link-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect(request, apply) {
      if (
        request.kind === 'process' &&
        request.symbol === 'spawnSync' &&
        request.arguments[0] === process.execPath
      ) {
        expect(matchDeclaredSensorTaskProcess(bound.root, request)).toBe(bound);
        starts += 1;
      }
      return apply();
    },
  };
  try {
    const reading = runWithAuthorityHostEffects(scope, () =>
      runWithResolvedSensorMember(bound.kind, () => executeSensorTask(bound)),
    );
    return { reading, starts };
  } finally {
    issuer.dispose();
  }
}

describe('independent native link custody', () => {
  it('executes the owned backend collection with an unconsumed preview alias outside its root', () => {
    const root = nativeFixture();
    const bound = binding(root);
    const result = executeReal(bound);
    expect(result.starts).toBe(1);
    expect(result.reading.status).toBe('pass');
    expect(result.reading.metrics?.candidate_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(result.reading.metrics?.native_collection_nonce).toMatch(/^[a-f0-9]{64}$/u);
    const forged = JSON.parse(JSON.stringify(result.reading)) as typeof result.reading;
    expect(() => attestNativeTaskExecution(root, forged, forged)).toThrow(
      'SENSE_NATIVE_EXECUTION_ORIGIN_UNTRUSTED',
    );
    expect(fs.existsSync(join(root, 'record/proofs/chain.json'))).toBe(false);
    attestNativeTaskExecution(
      root,
      result.reading,
      resolveSensorReadingInstance(root, result.reading),
    );
    const origin = JSON.parse(fs.readFileSync(join(root, 'record/proofs/chain.json'), 'utf8'));
    expect(origin.records).toHaveLength(1);
    expect(origin.records[0].action).toBe('sense.task.execute');
    expect(origin.records[0].context.git.head_sha).toBe(bound.plan.repository.commit);

    expect(fs.readlinkSync(join(root, alias))).toBe(literal);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, 60_000);
});

async function metadata(root: string, inputs = tracked(root)) {
  const { nativeCandidateLinkMetadata } =
    await import('../../src/commands/sense/native-candidate-links.js');
  return nativeCandidateLinkMetadata(root, inputs);
}
function toTarget(root: string, path: string) {
  return relative(dirname(join(root, alias)), join(root, path));
}

describe('independent tracked link metadata', () => {
  it('retains exact committed mode, literal bytes and the closed tracked target population', async () => {
    const root = fixture();
    const observed = await metadata(root);
    expect(observed.version).toBe('tracked-unconsumed-directory-links-v1');
    expect(observed.entries).toHaveLength(1);
    expect(observed.entries[0]).toMatchObject({
      path: alias,
      mode: '120000',
      literalSha256: hash(literal),
      target: 'docs/fixtures',
    });
    expect(observed.entries[0]?.members).toEqual([
      { path: 'docs/fixtures/one.json', mode: '100644', contentDigest: hash('{"fixture":1}\n') },
      { path: 'docs/fixtures/two.json', mode: '100644', contentDigest: hash('{"fixture":2}\n') },
    ]);
    expect(observed.entries[0]?.targetPopulationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await metadata(root)).toEqual(observed);
  });

  it('does not add a candidate identity or invent metadata when the tracked tree has no aliases', async () => {
    const root = fixture(false);
    expect(await metadata(root)).toEqual({
      version: 'tracked-unconsumed-directory-links-v1',
      entries: [],
    });
  });

  it('hashes canonical-equivalent committed link literals separately without changing target identity', async () => {
    const root = fixture();
    const first = await metadata(root);
    const differentLiteral = '../../../../../../docs/./fixtures';
    replaceLink(root, differentLiteral);
    commit(root, 'different committed literal, same canonical directory');
    const second = await metadata(root);
    expect(second.entries[0]?.literalSha256).toBe(hash(differentLiteral));
    expect(second.entries[0]?.literalSha256).not.toBe(first.entries[0]?.literalSha256);
    expect(second.entries[0]?.target).toBe(first.entries[0]?.target);
    expect(second.entries[0]?.targetPopulationSha256).toBe(
      first.entries[0]?.targetPopulationSha256,
    );
  });

  it('binds committed target byte, member mode and population changes independently', async () => {
    const root = fixture();
    const first = await metadata(root);
    put(root, 'docs/fixtures/one.json', '{"fixture":"changed"}\n');
    commit(root, 'changed tracked target bytes');
    const second = await metadata(root);
    expect(second.entries[0]?.targetPopulationSha256).not.toBe(
      first.entries[0]?.targetPopulationSha256,
    );
    fs.chmodSync(join(root, 'docs/fixtures/one.json'), 0o755);
    commit(root, 'changed tracked target mode');
    const third = await metadata(root);
    expect(third.entries[0]?.members.find((entry) => entry.path.endsWith('/one.json'))?.mode).toBe(
      '100755',
    );
    expect(third.entries[0]?.targetPopulationSha256).not.toBe(
      second.entries[0]?.targetPopulationSha256,
    );
    put(root, 'docs/fixtures/three.json', '{"fixture":3}\n');
    commit(root, 'additional tracked target member');
    const fourth = await metadata(root);
    expect(fourth.entries[0]?.members).toHaveLength(3);
    expect(fourth.entries[0]?.targetPopulationSha256).not.toBe(
      third.entries[0]?.targetPopulationSha256,
    );
  });

  it.each(['alias', 'target'] as const)(
    'refuses an incomplete task input closure missing the %s',
    async (missing) => {
      const root = fixture();
      const omitted = missing === 'alias' ? alias : 'docs/fixtures/one.json';
      await expect(
        metadata(
          root,
          tracked(root).filter((path) => path !== omitted),
        ),
      ).rejects.toThrow('SENSE_NATIVE_CONFIG_CLOSURE_INCOMPLETE');
    },
  );

  it.each([
    ['absolute', (root: string) => join(root, 'docs/fixtures')],
    ['escape', () => '../../../../../../../outside'],
    ['missing', () => '../../../../../../missing'],
    ['file alias', () => '../../../../../../docs/fixtures/one.json'],
    ['self cycle', () => 'fixtures'],
    ['ancestor', () => '..'],
    ['repository root', () => '../../../../../..'],
    ['case alias', () => '../../../../../../DOCS/fixtures'],
  ] as const)('refuses the committed %s directory target', async (_label, target) => {
    const root = fixture();
    replaceLink(root, target(root));
    commit(root);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
  });

  it.each([
    '.git/fixtures',
    '.ssh/fixtures',
    'credentials/fixtures',
    'secrets/fixtures',
    'node_modules/fixtures',
    '.devai/state/fixtures',
    '.devai/config/fixtures',
    'record/fixtures',
    'scratch/fixtures',
  ])('refuses the target namespace %s even when target bytes exist', async (target) => {
    const root = fixture();
    put(root, `${target}/data.json`, '{"fixture":true}\n');
    replaceLink(root, toTarget(root, target));
    commit(root);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
  });

  it('refuses a committed chained link instead of following its internally contained destination', async () => {
    const root = fixture();
    fs.symlinkSync('fixtures', join(root, 'docs/indirect'), 'dir');
    replaceLink(root, toTarget(root, 'docs/indirect'));
    commit(root);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
  });

  it('refuses a target subtree containing another committed symbolic link', async () => {
    const root = fixture();
    fs.symlinkSync('one.json', join(root, 'docs/fixtures/nested.json'));
    commit(root);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
  });

  it.each(['untracked.json', 'secret.ignored'])(
    'refuses target member %s absent from the committed roster',
    async (member) => {
      const root = fixture();
      put(root, `docs/fixtures/${member}`, 'uncommitted fixture input\n');
      if (member.endsWith('.ignored')) expect(git(root, 'status', '--porcelain')).toBe('');
      await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
    },
  );

  it('refuses a committed alias to an empty directory that Git cannot bind', async () => {
    const root = fixture();
    replaceLink(root, toTarget(root, 'docs/empty'));
    fs.mkdirSync(join(root, 'docs/empty'));
    commit(root);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
  });

  it.each([
    'link literal',
    'target bytes',
    'target mode',
    'link becomes regular',
    'regular becomes link',
  ] as const)('refuses dirty %s without stamping new candidate custody', async (mutation) => {
    const root = fixture();
    if (mutation === 'link literal') replaceLink(root, '../../../../../../docs/./fixtures');
    else if (mutation === 'target bytes') put(root, 'docs/fixtures/one.json', 'dirty\n');
    else if (mutation === 'target mode') fs.chmodSync(join(root, 'docs/fixtures/one.json'), 0o755);
    else if (mutation === 'link becomes regular') {
      fs.unlinkSync(join(root, alias));
      put(root, alias, literal);
    } else {
      fs.unlinkSync(join(root, 'src/regular.txt'));
      fs.symlinkSync('../docs/fixtures/one.json', join(root, 'src/regular.txt'));
    }
    await expect(metadata(root)).rejects.toThrow(
      /NATIVE_CANDIDATE_LINK_|AUDIT_PROJECTION_LINK_REFUSED/u,
    );
  });

  it('detects an actual link replacement between its authentic readlink observations', async () => {
    const root = fixture();
    await metadata(root);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let changed = false;
    vi.mocked(fs.readlinkSync).mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(actual.readlinkSync, actual, args);
      if (!changed && String(args[0]) === join(root, alias)) {
        changed = true;
        replaceLink(root, '../../../../../../docs/./fixtures');
      }
      return result;
    }) as typeof fs.readlinkSync);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
    expect(changed).toBe(true);
  });

  it('detects an ignored target member introduced between non-following directory observations', async () => {
    const root = fixture();
    await metadata(root);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let changed = false;
    vi.mocked(fs.readdirSync).mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(actual.readdirSync, actual, args);
      if (!changed && String(args[0]) === join(root, 'docs/fixtures')) {
        changed = true;
        put(root, 'docs/fixtures/race.ignored', 'introduced after the first real census\n');
      }
      return result;
    }) as typeof fs.readdirSync);
    await expect(metadata(root)).rejects.toThrow(/NATIVE_CANDIDATE_LINK_/u);
    expect(changed).toBe(true);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('does not grant alias reads to the strict candidate/audit reader', async () => {
    const root = fixture();
    await metadata(root);
    expect(() => readCandidateFile(root, `${alias}/one.json`)).toThrow(
      'AUDIT_PROJECTION_LINK_REFUSED',
    );
    expect(readCandidateFile(root, 'docs/fixtures/one.json').toString()).toBe('{"fixture":1}\n');
  });
});

describe('explicit native capability boundaries', () => {
  it.each(['configuration', 'selected test'] as const)(
    'keeps the selected %s strictly link-free despite unrelated metadata admission',
    (selected) => {
      const root = nativeFixture();
      const path = selected === 'configuration' ? 'vitest.config.mjs' : 'backend/tests/one.test.ts';
      const bytes = fs.readFileSync(join(root, path));
      put(root, 'docs/source.txt', bytes.toString('utf8'));
      fs.unlinkSync(join(root, path));
      fs.symlinkSync(
        relative(dirname(join(root, path)), join(root, 'docs/source.txt')),
        join(root, path),
      );
      commit(root, 'selected executable/config alias remains unsupported');
      expect(() => binding(root)).toThrow('AUDIT_PROJECTION_LINK_REFUSED');
    },
  );

  it.each(['target bytes', 'link literal'] as const)(
    'refuses a previously bound task after changing its %s, before real process admission',
    (changed) => {
      const root = nativeFixture();
      const bound = binding(root);
      if (changed === 'target bytes') put(root, 'docs/fixtures/one.json', 'dirty after binding\n');
      else replaceLink(root, '../../../../../../docs/./fixtures');
      expect(() => executeReal(bound)).toThrow('SENSE_NATIVE_CANDIDATE_DIRTY');
      expect(fs.existsSync(join(root, 'record/proofs/chain.json'))).toBe(false);
    },
  );

  it('does not promote actual traversal of an alias inside the collection glob', () => {
    const root = nativeFixture();
    // The backend glob now reaches this alias; a metadata-only allowance cannot grant traversal.
    fs.symlinkSync('../docs/fixtures', join(root, 'backend/fixtures'), 'dir');
    commit(root, 'alias inside the backend collection root');
    const result = executeReal(binding(root));
    expect(result.starts).toBe(1);
    expect(result.reading.status).not.toBe('pass');
    expect(JSON.stringify(result.reading.findings)).toContain('NATIVE_INPUT_COMPONENT_LINK');
  }, 60_000);

  it.skipIf(
    process.platform === 'linux' && process.version === 'v24.20.0' && process.getuid?.() === 1000,
  )('names the real host Linux derivation refusal rather than simulating Linux transport', () => {
    // This host is not the exact owned Linux runtime. No platform/uid/workspace value is mocked.
    expect(
      process.platform !== 'linux' || process.version !== 'v24.20.0' || process.getuid?.() !== 1000,
    ).toBe(true);
    const input = {
      schemaVersion: '1.0.0',
      nonce: 'a'.repeat(64),
      repository: '/workspace',
      kind: 'unit_test',
      inputs: { taskId: 'native', population: 'link-fixture' },
      candidate: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      backendRecordSha256: 'd'.repeat(64),
      snapshotManifestSha256: {
        candidate: 'e'.repeat(64),
        dependencies: 'f'.repeat(64),
        helpers: '1'.repeat(64),
      },
    };
    expect(() => deriveNativeLinuxTask(JSON.stringify(input))).toThrow(
      'NATIVE_LINUX_PLAN_RUNTIME_UNSUPPORTED',
    );
  });
});
