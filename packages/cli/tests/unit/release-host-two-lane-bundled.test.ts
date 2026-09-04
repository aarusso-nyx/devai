import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installedPackage } from '../helpers/release-mutation-inputs-fixture.js';
import { loadSourceReleaseToolchainFixtureDefinition } from '../../src/services/release-toolchain-fixture-definition.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const source = join(ROOT, 'packages/cli/src');
const helpers = join(ROOT, 'packages/cli/tests/helpers');
const require = createRequire(join(ROOT, 'packages/cli/package.json'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('protected host two-lane test runtime', () => {
  it('binds a genuine package singleton and routes the fixed fixture without certification effects', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'devai test bundle ç-'));
    try {
      const packageSnapshot = installedPackage();
      const schemaAssets = Object.fromEntries(
        packageSnapshot.manifest
          .filter((entry) => entry.path.startsWith('dist/runtime/index/schemas/'))
          .map((entry) => [
            entry.path.slice('dist/runtime/index/'.length),
            packageSnapshot.read(entry.path).toString(),
          ]),
      );
      const registry = readFileSync(join(ROOT, 'law/policy/sensor-registry.json'), 'utf8');
      const presets = readFileSync(join(ROOT, 'law/policy/sense-presets.json'), 'utf8');
      const library = readFileSync(join(dirname(require.resolve('typescript')), 'lib.d.ts'));
      const tsVersion = JSON.parse(
        readFileSync(require.resolve('typescript/package.json'), 'utf8'),
      ) as { version: string };
      const definition = loadSourceReleaseToolchainFixtureDefinition();
      const fixturePrefix = 'dist/runtime/fixtures/mutation-toolchain/';
      const extraAssets = [
        ...definition.manifest.map((entry) => ({
          path: `${fixturePrefix}files/${entry.path}.fixture`,
          bytes: definition.read(entry.path),
        })),
        {
          path: `${fixturePrefix}manifest.json`,
          bytes: Buffer.from(JSON.stringify(definition, null, 2) + '\n'),
        },
        { path: 'dist/runtime/index/sensor-registry.json', bytes: Buffer.from(registry) },
        { path: 'dist/runtime/index/sense-presets.json', bytes: Buffer.from(presets) },
        { path: 'dist/runtime/index/lib.d.ts', bytes: library },
        {
          path: 'dist/runtime/index/typescript-libraries.json',
          bytes: Buffer.from(
            JSON.stringify({
              schemaVersion: '1.0.0',
              compiler_version: tsVersion.version,
              files: [{ path: 'lib.d.ts', sha256: hash(library) }],
            }),
          ),
        },
      ].map((entry) => ({ ...entry, mode: 0o644, bytes: entry.bytes.toString('base64') }));
      const state = `export const extraAssets = ${JSON.stringify(extraAssets)}; export const observations = { calls: [], stores: [], container_executions: 0 }; export let adapters; export function install(value) { adapters = value; }`;
      const providerHelper = join(helpers, 'release-toolchain-provider-fixture.ts');
      const cliMock = `import { readFileSync } from 'node:fs';
import { observations, adapters } from 'test-host-runtime-state';
import { readProtectedReleaseRepositoryIdentity } from '@devai-nyx/authority';
export function assertCliInvocationIdle() {}
export async function invokeDevaiCli(args) {
 const action = args.slice(0, 2).join(' '); const value = (flag) => args[args.indexOf(flag) + 1];
 const root = value('--repo-root'); const state = args.includes('--state-root') ? value('--state-root') : undefined;
 if (action === 'release plan') { observations.calls.push({action, root}); return {exit_code:0, stdout:'', stderr:''}; }
 const request = JSON.parse(readFileSync(value('--request'), 'utf8'));
 const identity = readProtectedReleaseRepositoryIdentity();
 const resolution = adapters.policy_resolution({repository_id:request.repository_locator.id,candidate:{commit:request.candidate_locator.commit,tree:request.candidate_locator.tree},release_unit:request.candidate_locator.release_units[0].release_unit});
 if (resolution.repository.id !== identity.repository.id) throw Error('wrong routed policy');
 observations.calls.push({action,root,state,repository:identity.repository.id});
 if(action === 'release certify') { adapters.certification_provider(request); throw Error('certification unexpectedly escaped'); }
 const outcome = await adapters.preflight_provider(request)(request);
 return {exit_code:outcome.outcome==='success'?0:1, stdout:JSON.stringify(outcome),stderr:''};
}`;
      const imported = (await import(require.resolve('rolldown'))) as {
        rolldown: (
          options: unknown,
        ) => Promise<{ write: (options: unknown) => Promise<unknown>; close: () => Promise<void> }>;
      };
      const bundle = await imported.rolldown({
        input: join(ROOT, 'packages/cli/tests/fixtures/release-host-two-lane-harness.mjs'),
        platform: 'node',
        external: (id: string) => id.startsWith('node:'),
        plugins: [
          {
            name: 'test-only-runtime-transports-and-code-bound-assets',
            resolveId(id: string) {
              return id === 'test-host-runtime-state' ? '\0test-host-runtime-state' : null;
            },
            load(id: string) {
              if (id === '\0test-host-runtime-state') return state;
              if (id === join(source, 'cli-runtime.ts')) return cliMock;
              if (id === join(source, 'commands/release/lifecycle.ts'))
                return `export { install as installReleaseLifecycleCommandAdapters } from 'test-host-runtime-state';`;
              if (id === join(source, 'services/check-runner/runner.ts'))
                return `import { fixtureRuntime } from ${JSON.stringify(providerHelper)}; export function runCheckTasks(options) { return fixtureRuntime.runCheckTasks(options); } export async function runCheckTasksAsync(options) { return fixtureRuntime.runCheckTasks(options); }`;
              return null;
            },
            transform(code: string, id: string) {
              if (id === join(source, 'services/release-certification-container.ts')) {
                return (
                  code.replace(
                    'export class ProtectedCertificationContainer',
                    'class OriginalProtectedCertificationContainer',
                  ) +
                  `
import { containerState } from ${JSON.stringify(providerHelper)};
import { observations } from 'test-host-runtime-state';
export class ProtectedCertificationContainer extends OriginalProtectedCertificationContainer {
 runBound(_binding, fn) { return fn(); } verifyRuntime() {}
 execute(input) { observations.container_executions += 1; const select = (paths) => paths.flatMap(path => { const bytes=containerState.outputs.get(path); return bytes ? [{path,mode:'100644',bytes:Buffer.from(bytes)}] : []; });
 return {result:{status:containerState.status,signal:null,stdout:'',stderr:''},outputs:containerState.status===0?select(input.declared_outputs):[],diagnostic_outputs:select(input.diagnostic_output_paths??[])}; }
}`
                );
              }
              if (
                id === join(source, 'services/release-evidence-store.ts') ||
                id === join(source, 'services/release-artifact-store.ts')
              ) {
                const name = id.endsWith('release-evidence-store.ts')
                  ? 'createReleaseCertificationEvidenceStore'
                  : 'createReleaseArtifactStore';
                return (
                  code.replace(`export function ${name}(`, `function observed_${name}(`) +
                  `\nimport {observations} from 'test-host-runtime-state'; export function ${name}(input) { observations.stores.push({root:input.root}); return observed_${name}(input); }`
                );
              }
              if (id.startsWith(helpers)) {
                return code
                  .replace(/const ROOT = [^;]+;/u, `const ROOT = ${JSON.stringify(ROOT)};`)
                  .replace(
                    /const FIXTURE_ROOT = [^;]+;/u,
                    `const FIXTURE_ROOT = ${JSON.stringify(join(ROOT, 'packages/cli/tests/fixtures/mutation-toolchain'))};`,
                  );
              }
              const selected = id.endsWith('/packages/schemas/dist/index.js')
                ? ['bundledPackageAssets', { ...schemaAssets, 'sensor-registry.json': registry }]
                : id.endsWith('/packages/sensors/dist/sensor-registry.js')
                  ? ['bundledSensorRegistry', registry]
                  : id.endsWith('/packages/sensors/dist/sense-presets.js')
                    ? ['bundledSensePresets', presets]
                    : undefined;
              if (selected === undefined) return null;
              return code.replace(
                new RegExp(`function ${selected[0]}\\(\\) \\{\\s*return undefined;\\s*\\}`, 'u'),
                `function ${selected[0]}() { return ${JSON.stringify(selected[1])}; }`,
              );
            },
          },
        ],
      });
      const directory = join(temporary, 'dist/runtime/index');
      mkdirSync(directory, { recursive: true });
      copyFileSync(
        join(ROOT, 'law/policy/round-execution.json'),
        join(directory, 'round-execution.json'),
      );
      const output = join(directory, 'host-test.mjs');
      await bundle.write({
        file: output,
        format: 'esm',
        codeSplitting: false,
        sourcemap: false,
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;",
      });
      await bundle.close();
      const result = execFileSync(process.execPath, [output], {
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 8 * 1024 * 1024,
      });
      expect(JSON.parse(result)).toMatchObject({
        verdict: 'pass',
        packages: 10,
        fixture: true,
        store_count: 2,
      });
      const absent = execFileSync(process.execPath, [output, 'without-fixture'], {
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 8 * 1024 * 1024,
      });
      expect(JSON.parse(absent)).toEqual({ verdict: 'pass', fixture: false });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
