// Test construction only: no DEVAI runtime implementation or authority is supplied here.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function installNativeVitest(
  repositoryRoot: string,
  fixtureRoot: string,
  options: { defaultVite?: boolean; isolateRunner?: boolean } = {},
): void {
  const vite = dirname(
    realpathSync(
      options.defaultVite === true
        ? createRequire(
            realpathSync(join(repositoryRoot, 'node_modules/vitest/package.json')),
          ).resolve('vite/package.json')
        : join(repositoryRoot, 'node_modules/vite-native-fixture/package.json'),
    ),
  );
  if (
    options.defaultVite !== true &&
    JSON.parse(readFileSync(join(vite, 'package.json'), 'utf8'))['version'] !== '7.3.6'
  )
    throw new Error('Reviewed native fixture requires exactly Vite 7.3.6');
  const copyPackage = (manifest: string, target: string): void => {
    const source = dirname(realpathSync(manifest));
    const resolver = createRequire(join(source, 'package.json'));
    const document = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    cpSync(source, target, {
      recursive: true,
      filter: (path) => path !== join(source, 'node_modules'),
    });
    const dependencyRoot = (name: string): string => {
      try {
        return dirname(resolver.resolve(`${name}/package.json`));
      } catch {
        let directory = dirname(resolver.resolve(name));
        for (;;) {
          const path = join(directory, 'package.json');
          if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8'))['name'] === name)
            return directory;
          const parent = dirname(directory);
          if (parent === directory) throw new Error(`Native fixture dependency not found: ${name}`);
          directory = parent;
        }
      }
    };
    for (const name of Object.keys({
      ...document.dependencies,
      ...document.optionalDependencies,
      ...document.peerDependencies,
    })) {
      let dependency: string;
      try {
        dependency = name === 'vite' ? vite : dependencyRoot(name);
      } catch (error) {
        if (
          document.optionalDependencies?.[name] !== undefined ||
          document.peerDependenciesMeta?.[name]?.optional === true
        )
          continue;
        throw error;
      }
      const local = join(target, 'node_modules', name);
      mkdirSync(dirname(local), { recursive: true });
      if (
        name === '@vitest/mocker' ||
        (name === '@vitest/runner' && options.isolateRunner === true)
      )
        copyPackage(join(dependency, 'package.json'), local);
      else symlinkSync(dependency, local, 'dir');
    }
  };
  mkdirSync(join(fixtureRoot, 'node_modules/.bin'), { recursive: true });
  copyPackage(
    join(repositoryRoot, 'node_modules/vitest/package.json'),
    join(fixtureRoot, 'node_modules/vitest'),
  );
  symlinkSync('../vitest/vitest.mjs', join(fixtureRoot, 'node_modules/.bin/vitest'));
}

/** Install the actual package's declared runtime dependencies into a copied fixture. */
export function linkRuntimePackageDependencies(source: string, target: string): void {
  const document = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const resolver = createRequire(join(source, 'package.json'));
  for (const name of Object.keys({ ...document.dependencies, ...document.optionalDependencies })) {
    let manifest: string;
    try {
      manifest = resolver.resolve(`${name}/package.json`);
    } catch (error) {
      if (document.optionalDependencies?.[name] !== undefined) continue;
      throw error;
    }
    const local = join(target, 'node_modules', name);
    mkdirSync(dirname(local), { recursive: true });
    symlinkSync(dirname(realpathSync(manifest)), local, 'dir');
  }
}

/** A clean Playwright package graph, without the workspace's unrelated hoisted optionals. */
export function installNativePlaywright(repositoryRoot: string, fixtureRoot: string): void {
  const test = realpathSync(
    join(repositoryRoot, 'node_modules/playwright-native-fixture/package.json'),
  );
  const playwright = createRequire(test).resolve('playwright/package.json');
  const resolver = createRequire(playwright);
  const core = resolver.resolve('playwright-core/package.json');
  const packages = [
    ['@playwright/test', test],
    ['playwright', playwright],
    ['playwright-core', core],
  ];
  try {
    packages.push(['playwright/node_modules/fsevents', resolver.resolve('fsevents/package.json')]);
    const vite = realpathSync(
      join(repositoryRoot, 'node_modules/vite-native-fixture/package.json'),
    );
    const fsevents = createRequire(vite).resolve('fsevents/package.json');
    if (JSON.parse(readFileSync(fsevents, 'utf8'))['version'] !== '2.3.3')
      throw new Error('Reviewed native fixture requires fsevents 2.3.3');
    packages.push(['fsevents', fsevents]);
  } catch (error) {
    // Playwright declares this macOS-only dependency optional; the tests still execute everywhere.
    if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') throw error;
  }
  for (const [name, manifest] of packages) {
    const source = dirname(realpathSync(String(manifest)));
    const target = join(fixtureRoot, 'node_modules', String(name));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      filter: (path) => path !== join(source, 'node_modules'),
    });
  }
  mkdirSync(join(fixtureRoot, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../@playwright/test/cli.js', join(fixtureRoot, 'node_modules/.bin/playwright'));
}
