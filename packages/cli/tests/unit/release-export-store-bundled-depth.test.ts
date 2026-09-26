import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createReleaseExportProvider } from '../../src/services/release-export-provider.js';
import type { ReleaseLifecycleRequest } from '../../src/services/release-lifecycle-execution.js';

/**
 * This is deliberately a provider-boundary test, not installed-package acceptance.
 * The latter requires the trusted host composition to issue a live invocation context.
 */
describe('release export artifact-store provider boundary', () => {
  it('refuses an unbound invocation before any reader, signer, or store effect', async () => {
    const readParent = vi.fn();
    const readCertifiedEvidenceCarrier = vi.fn();
    const sign = vi.fn();
    const verify = vi.fn();
    const { provider } = createReleaseExportProvider({
      store: {
        root: '/private/tmp/devai-export-provider-unbound',
        sink_id: 'fixture-export-sink',
        repository_roots: [],
        max_blob_bytes: 64 * 1024,
        closure_limits: {
          maximum_archive_bytes: 64 * 1024,
          maximum_unpacked_bytes: 64 * 1024,
          maximum_git_bytes: 64 * 1024,
          maximum_git_entries: 100,
        },
        transport_limits: {
          maximum_transport_bytes: 64 * 1024,
          maximum_decoded_bytes: 64 * 1024,
          maximum_entries: 100,
        },
        transcript_limits: {
          maximum_transcript_bytes: 64 * 1024,
          maximum_provider_result_bytes: 64 * 1024,
          maximum_packages: 10,
        },
        // The invocation-context gate precedes package/closure use.  This intentionally
        // incomplete value proves it cannot become a substitute for an installed host.
        implementation: {} as never,
        closures: [],
        parent_reader: { readArtifact: readParent },
      },
      plan: {},
      mutation_source: { unit_mutation_maximum_bytes: 64 * 1024 },
      certification_source: { readCertifiedEvidenceCarrier },
      provider: { kind: 'evidence-export', provider_id: 'fixture-export-provider' },
      destination: { kind: 'evidence-destination', exact_identifier: 'fixture/export' },
      trust: {
        trust_root_id: 'fixture/trust-root',
        trust_store_digest_sha256: 'a'.repeat(64),
        key_id: 'fixture-key',
        signature_algorithm: 'ed25519',
      },
      signer: { sign, verify },
    });

    const result = await provider({} as ReleaseLifecycleRequest);

    expect(result).toEqual({
      outcome: 'failure',
      dispatch_status: 'failed-before-dispatch',
      code: 'release-export-artifact-sink-protocol-invalid',
    });
    expect(readParent).not.toHaveBeenCalled();
    expect(readCertifiedEvidenceCarrier).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('runs the v3 none carrier through the bundled protected host lifecycle', async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const temporary = mkdtempSync(join(tmpdir(), 'devai export bundle ç-'));
    const runtime = join(temporary, 'dist/runtime/index');
    mkdirSync(runtime, { recursive: true });
    const output = join(runtime, `release-export-fixture-${randomUUID()}.mjs`);
    try {
      // Keep this equivalent to the established bundled-host harness: the runtime is
      // bound to code-injected assets, never an ambient schemas directory.
      const schemaAssets = Object.fromEntries(
        readdirSync(join(root, 'law/schemas'))
          .filter((name) => name.endsWith('.schema.json'))
          .map((name) => [
            `schemas/${name}`,
            readFileSync(join(root, 'law/schemas', name), 'utf8'),
          ]),
      );
      const registry = readFileSync(join(root, 'law/policy/sensor-registry.json'), 'utf8');
      const presets = readFileSync(join(root, 'law/policy/sense-presets.json'), 'utf8');
      const { rolldown } = (await import('rolldown')) as {
        rolldown: (input: unknown) => Promise<{
          write: (output: unknown) => Promise<unknown>;
          close: () => Promise<void>;
        }>;
      };
      const bundle = await rolldown({
        input: join(
          root,
          'packages/cli/tests/fixtures/release-export-store-bundled-depth-harness.mjs',
        ),
        platform: 'node',
        external: (id: string) => id.startsWith('node:'),
        plugins: [
          {
            name: 'fixture-only-protected-container-transport',
            transform(code: string, id: string) {
              if (!id.endsWith('/services/release-certification-container.ts')) return null;
              return (
                code.replace(
                  'export class ProtectedCertificationContainer',
                  'class OriginalProtectedCertificationContainer',
                ) +
                `
// Fixture-only transport: retain the real captured identity and binding checks,
// while avoiding a Docker daemon for this none-carrier lifecycle exercise.
export class ProtectedCertificationContainer extends OriginalProtectedCertificationContainer {
  runBound(binding: any, operation: () => unknown) { return super.runBound(binding, operation); }
  verifyRuntime() {}
  execute() { return { result: { status: 0, signal: null, stdout: '', stderr: '' }, outputs: [], diagnostic_outputs: [] }; }
}`
              );
            },
          },
          {
            name: 'fixture-only-bundled-policy-assets',
            transform(code: string, id: string) {
              const selected = id.endsWith('/packages/schemas/dist/index.js')
                ? ['bundledPackageAssets', { ...schemaAssets, 'sensor-registry.json': registry }]
                : id.endsWith('/packages/sensors/dist/sensor-registry.js')
                  ? ['bundledSensorRegistry', registry]
                  : id.endsWith('/packages/sensors/dist/sense-presets.js')
                    ? ['bundledSensePresets', presets]
                    : undefined;
              if (selected === undefined) {
                // Workspace resolution may select the source form while preserving the
                // exact package helper body. It is still the same code-bound asset seam.
                if (/function bundledPackageAssets\(\)[^{]*\{\s*return undefined;\s*\}/u.test(code))
                  return code.replace(
                    /function bundledPackageAssets\(\)[^{]*\{\s*return undefined;\s*\}/u,
                    // A function replacer keeps `$` sequences in asset bytes literal.
                    () =>
                      `function bundledPackageAssets() { return ${JSON.stringify({ ...schemaAssets, 'sensor-registry.json': registry })}; }`,
                  );
                return null;
              }
              return code.replace(
                new RegExp(
                  `function ${selected[0]}\\(\\)(?:\\s*:[^{]+)?\\s*\\{\\s*return undefined;\\s*\\}`,
                  'u',
                ),
                () => `function ${selected[0]}() { return ${JSON.stringify(selected[1])}; }`,
              );
            },
          },
          {
            name: 'fixture-only-reconciliation-diagnostic',
            transform(code: string, id: string) {
              if (!id.includes('release-lifecycle-execution')) return null;
              return code
                .replace(
                  'storeRecords = input.store.readStoreRecords();',
                  "storeRecords = input.store.readStoreRecords();\nconsole.error('fixture reconciliation store-records', storeRecords.length);",
                )
                .replace(
                  'states = input.store.readStateRecords();',
                  "states = input.store.readStateRecords();\nconsole.error('fixture reconciliation states', states.length);",
                )
                .replace(
                  'head = input.store.readHead();',
                  "head = input.store.readHead();\nconsole.error('fixture reconciliation head', head === null ? 'null' : 'present');",
                )
                .replace(
                  'const reduced = reduceStoreRecords(storeRecords);',
                  "const reduced = reduceStoreRecords(storeRecords);\nconsole.error('fixture reconciliation store-reduction', reduced.ok, reduced.ambiguous, reduced.errors);",
                )
                .replace(
                  'const stateReduction = reduceReleaseStates(states);',
                  "const stateReduction = reduceReleaseStates(states);\nconsole.error('fixture reconciliation state-reduction', stateReduction.ok, stateReduction.errors);",
                );
            },
          },
          {
            name: 'fixture-helper-root',
            transform(code: string, id: string) {
              if (!id.startsWith(join(root, 'packages/cli/tests/helpers'))) return null;
              return code.replace(/const ROOT = [^;]+;/u, `const ROOT = ${JSON.stringify(root)};`);
            },
          },
        ],
      });
      await bundle.write({
        file: output,
        format: 'esm',
        codeSplitting: false,
        sourcemap: false,
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;",
      });
      await bundle.close();
      const bundledPolicy = join(temporary, 'dist/law/policy');
      mkdirSync(bundledPolicy, { recursive: true });
      writeFileSync(
        join(bundledPolicy, 'trusted-local-rc-verifier-package.json'),
        readFileSync(join(root, 'law/policy/trusted-local-rc-verifier-package.json')),
      );
      writeFileSync(
        join(runtime, 'round-execution.json'),
        readFileSync(join(root, 'law/policy/round-execution.json')),
      );
      writeFileSync(
        join(temporary, 'dist/runtime/package.json'),
        readFileSync(join(root, 'packages/cli/dist/runtime/package.json')),
      );
      const stdout = execFileSync(process.execPath, [output], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DEVAI_TEST_ROOT: root },
      });
      expect(JSON.parse(stdout)).toMatchObject({ verdict: 'pass', mode: 'none' });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
