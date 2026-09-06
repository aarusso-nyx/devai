import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps pinned vendor bytes exact through the real Stryker preprocessor', async () => {
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve('@stryker-mutator/core/package.json'));
  const { DisableTypeChecksPreprocessor } = await import(
    pathToFileURL(join(core, 'dist/src/sandbox/disable-type-checks-preprocessor.js')).href
  );
  const coreRequire = createRequire(join(core, 'package.json'));
  const { disableTypeChecks } = await import(
    pathToFileURL(coreRequire.resolve('@stryker-mutator/instrumenter')).href
  );
  const source = readFileSync('packages/cli/src/services/release-mutation-program.ts', 'utf8');
  const setting = /disableTypeChecks: (false)/u.exec(source)?.[1];
  expect(setting).toBe('false');
  const paths = [
    'packages/cli/vendor/evidence-verification/src/verify.js',
    'packages/cli/vendor/evidence-verification/test/verifier.test.js',
    'packages/cli/tests/fixtures/mutation-toolchain/subject.ts',
    'packages/cli/src/example.ts',
    'packages/authority/tests/example.test.ts',
  ];
  const content = 'export const value = 1;\n';
  const observed = new Map(paths.map((path) => [path, content]));
  const project = {
    files: new Map(
      paths.map((path) => [
        path,
        {
          toInstrumenterFile: async () => ({ name: path, content }),
          setContent: (value: string) => observed.set(path, value),
        },
      ]),
    ),
  };
  await new DisableTypeChecksPreprocessor(
    { warn: () => undefined },
    {
      disableTypeChecks: setting !== 'false',
      mutator: { plugins: [] },
      warnings: true,
    },
    disableTypeChecks,
  ).preprocess(project);
  expect(observed.get(paths[0] ?? '')).toBe(content);
  expect(observed.get(paths[1] ?? '')).toBe(content);
  for (const path of paths) expect(observed.get(path)).toBe(content);
});
