// ADR-SCR-0019/0020: installed public factories retain their real typed contracts.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const installed = resolve(
  process.env['DEVAI_TEST_INSTALLED_PACKAGE'] ?? join(root, 'packages/cli'),
);
const consumer = mkdtempSync(join(tmpdir(), 'devai public types ç '));
const copied = join(consumer, 'node_modules/@aarusso-nyx/devai');
mkdirSync(dirname(copied), { recursive: true });
mkdirSync(copied);
cpSync(join(installed, 'package.json'), join(copied, 'package.json'));
cpSync(join(installed, 'dist'), join(copied, 'dist'), { recursive: true });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const fixtureManifest = realpathSync(
  join(root, 'node_modules/devai-native-coverage-compiler-fixture/package.json'),
);
const compilerManifest = createRequire(fixtureManifest).resolve('typescript/package.json');
const compiler: typeof import('typescript') = createRequire(import.meta.url)(
  dirname(compilerManifest),
);

afterAll(() => rmSync(consumer, { recursive: true, force: true }));

describe('installed native public declarations', () => {
  it('ships the declared public type entry for each native factory', () => {
    const manifest = JSON.parse(readFileSync(join(copied, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string }>;
    };
    for (const name of ['./native-coverage-adapter', './native-service-fixtures']) {
      const declaration = manifest.exports[name]?.types;
      expect(declaration, name).toMatch(/^\.\/dist\/.*\.d\.ts$/u);
      expect(existsSync(join(copied, declaration ?? 'missing')), name).toBe(true);
    }
  });

  it('typechecks a strict TS6 consumer through public exports without private imports or ambient stubs', () => {
    expect(compiler.version).toBe('6.0.3');
    const file = join(consumer, 'consumer.ts');
    writeFileSync(
      file,
      `
import { createNativeServiceFixtures, type NativeServiceFixtures, type NativePostgresFixture,
  type NativeRedisFixture, type NativeLocalstackFixture } from '@aarusso-nyx/devai/native-service-fixtures';
import { createNativeCoverageAdapter, isProxy, sameNativeData, type NativeCoverageAdapterOptions }
  from '@aarusso-nyx/devai/native-coverage-adapter';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type ServiceFactoryIsTyped = AssertFalse<IsAny<typeof createNativeServiceFixtures>>;
type CoverageFactoryIsTyped = AssertFalse<IsAny<typeof createNativeCoverageAdapter>>;
type ServiceAPIIsTyped = AssertFalse<IsAny<ReturnType<typeof createNativeServiceFixtures>>>;
type CoverageAPIIsTyped = AssertFalse<IsAny<ReturnType<typeof createNativeCoverageAdapter>>>;
const fixtures: NativeServiceFixtures = createNativeServiceFixtures();
async function useServices() {
  const pg: NativePostgresFixture = await fixtures.postgres();
  const host: '127.0.0.1' = pg.host;
  const database: 'postgres' = pg.database;
  const redis: NativeRedisFixture = await fixtures.redis();
  const pause: Promise<void> = redis.pause();
  const resume: Promise<void> = redis.resume();
  const s3: NativeLocalstackFixture = await fixtures.localstackS3();
  const kms: NativeLocalstackFixture = await fixtures.localstackS3Kms();
  const key: 'test' = s3.credentials.accessKeyId;
  const region: 'us-east-1' = kms.region;
  await Promise.all([pause, resume, pg.stop(), redis.stop(), s3.stop(), kms.stop(), fixtures.verify()]);
  return { host, database, key, region };
}
const options: NativeCoverageAdapterOptions = { packageDir: 'packages/example', config: 'tsconfig.json',
  modules: [{ source: 'src/example.ts', output: 'dist/example.js' }], includes: ['src/**/*.ts'], excludes: [] };
const adapter = createNativeCoverageAdapter(options);
const hash: string = adapter.sha256(new Uint8Array([1, 2]));
const candidate: string = adapter.candidate();
const census: readonly string[] = adapter.sourceCensus();
const outputs = adapter.compile({ mode: 'production', source: 'src/example.ts' }).outputs;
const text: string = adapter.readVerifiedOutput('dist/example.js');
const equal: boolean = sameNativeData({ hash }, { hash });
const proxy: boolean = isProxy(options);
adapter.verify();
adapter.evidence();
// @ts-expect-error Public service factory accepts no caller context.
createNativeServiceFixtures({ endpoint: 'http://unowned' });
// @ts-expect-error Redis controls accept no caller command or arguments.
fixtures.redis().then(redis => redis.pause('SIGSTOP'));
// @ts-expect-error There is no generic container execution capability.
fixtures.redis().then(redis => redis.exec('whoami'));
// @ts-expect-error Compiler mode is a closed public union.
adapter.compile({ mode: 'arbitrary', source: 'src/example.ts' });
// @ts-expect-error Public fixtures do not expose private host context.
fixtures.context;
// @ts-expect-error Public adapter does not expose privileged IO.
adapter.io;
// @ts-expect-error Public evidence cannot claim native standing.
adapter.evidence().standing;
void [useServices, candidate, census, outputs, text, equal, proxy];
`,
    );
    const program = compiler.createProgram([file], {
      target: compiler.ScriptTarget.ES2022,
      module: compiler.ModuleKind.NodeNext,
      moduleResolution: compiler.ModuleResolutionKind.NodeNext,
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    });
    const diagnostics = compiler.getPreEmitDiagnostics(program);
    const text = compiler.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => consumer,
      getNewLine: () => '\n',
    });
    expect(diagnostics, text).toEqual([]);
  });
});
