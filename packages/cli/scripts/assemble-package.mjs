#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import ts from 'typescript';
import { ROSTER as schemaRoots } from '../../schemas/dist/roster.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const distRoot = join(packageRoot, 'dist');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-cli-assembly-'));
const bundlePath = join(temporaryRoot, 'release-host.js');
const bootstrapPath = join(temporaryRoot, 'release-host-bootstrap.js');
const executablePath = join(temporaryRoot, 'bin.js');
const declarationsRoot = join(temporaryRoot, 'types/cli');
const scaffoldModule = join(repositoryRoot, 'packages/skills/dist/operations/scaffold/index.js');
const verifierSourceRoot = join(packageRoot, 'vendor/evidence-verification');
const verifierRuntimeRoot = join(distRoot, 'runtime/evidence-verification');
const verifierBins = [
  'build-policy-cli.js',
  'cli.js',
  'bundle-cli.js',
  'export-cli.js',
  'publish-cli.js',
];

const policyFiles = [
  'action-registry.json',
  'check-suites.json',
  'domains.json',
  'forbidden-actions.json',
  'github-issues-tracking.json',
  'glob-guards.json',
  'model-runtime-registry.json',
  'mutation-evidence-v2.json',
  'mutation-strength.json',
  'round-execution.json',
  'release-lifecycle.json',
  'release-verification.json',
  'scorecard-na.json',
  'sense-presets.json',
  'sensor-registry.json',
  'subprocess-effects.json',
  'thresholds.json',
  'trusted-local-rc-verifier-package.json',
];

function schemaClosure(roots) {
  const sourceRoot = join(repositoryRoot, 'law/schemas');
  const pending = [...roots];
  const selected = new Set();
  const referencedSchemas = (value) => {
    if (Array.isArray(value)) return value.flatMap(referencedSchemas);
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => {
      if (key === '$ref' && typeof child === 'string') {
        const match = /^([^#]+\.schema\.json)(?:#.*)?$/u.exec(child);
        return match?.[1] === undefined ? [] : [match[1]];
      }
      return referencedSchemas(child);
    });
  };
  while (pending.length > 0) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const source = join(sourceRoot, name);
    if (!existsSync(source)) throw new Error(`PACKAGE_SCHEMA_MISSING:${name}`);
    selected.add(name);
    const document = JSON.parse(readFileSync(source, 'utf8'));
    const refs = referencedSchemas(document);
    for (const ref of refs) if (!selected.has(ref)) pending.push(ref);
  }
  return [...selected].sort();
}

function copyFiles(sourceRoot, targetRoot, names) {
  mkdirSync(targetRoot, { recursive: true });
  for (const name of names) copyFileSync(join(sourceRoot, name), join(targetRoot, name));
}

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory()
      ? filesUnder(root, path)
      : [relative(root, path).split(sep).join('/')];
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateVerifierAssets() {
  const provenancePath = join(verifierSourceRoot, 'provenance.json');
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  if (
    provenance.schemaVersion !== '1.0.0' ||
    provenance.sourceCommit !== '098d090013dda34e38d1045ba06274d99bd5aec1' ||
    !Array.isArray(provenance.files)
  ) {
    throw new Error('PACKAGE_VERIFIER_PROVENANCE_INVALID');
  }
  const declared = provenance.files.map((entry) => entry.path);
  const expectedPopulation = ['provenance.json', ...declared].sort();
  const actualPopulation = filesUnder(verifierSourceRoot).sort();
  // Upstream verifier tests remain source-owned regression assets. They are
  // deliberately outside the provenance-declared runtime and npm package.
  const sourceOnlyTests = actualPopulation.filter((path) => path.startsWith('test/'));
  const expectedSourceOnlyTests = [
    'artifact-safety.test.js',
    'export.test.js',
    'mutation-v21-contract.test.js',
    'mutation.test.js',
    'policy-builder.test.js',
    'publish.test.js',
    'verifier.test.js',
  ].map((name) => `test/${name}`);
  const runtimePopulation = actualPopulation.filter((path) => !path.startsWith('test/'));
  if (
    declared.length !== 24 ||
    new Set(declared).size !== declared.length ||
    JSON.stringify(sourceOnlyTests) !== JSON.stringify(expectedSourceOnlyTests) ||
    declared.some((path) => path.startsWith('test/')) ||
    JSON.stringify(runtimePopulation) !== JSON.stringify(expectedPopulation)
  ) {
    throw new Error('PACKAGE_VERIFIER_POPULATION_INVALID');
  }
  for (const entry of provenance.files) {
    if (
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      sha256(join(verifierSourceRoot, entry.path)) !== entry.sha256
    ) {
      throw new Error(`PACKAGE_VERIFIER_DIGEST_INVALID:${String(entry.path)}`);
    }
  }
  for (const sourcePath of declared.filter((path) => path.startsWith('src/'))) {
    const source = readFileSync(join(verifierSourceRoot, sourcePath), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('./'))
        throw new Error(`PACKAGE_VERIFIER_IMPORT_INVALID:${sourcePath}:${specifier}`);
      const dependency = resolve(dirname(join(verifierSourceRoot, sourcePath)), specifier);
      const fromRoot = relative(verifierSourceRoot, dependency);
      if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || !existsSync(dependency)) {
        throw new Error(`PACKAGE_VERIFIER_IMPORT_MISSING:${sourcePath}:${specifier}`);
      }
    }
  }
  return provenance;
}

const workspacePackage = /^@devai-nyx\//u;
// Protected startup must not execute an unchecked transitive node_modules graph.
// Keep only optional integrations external for ordinary CLI compatibility; the
// protected bootstrap refuses those imports instead of silently falling back.
const optionalPackages = ['@anthropic-ai/sdk', 'openai', 'pg'];
const external = (id) =>
  isBuiltin(id) || optionalPackages.some((name) => id === name || id.startsWith(`${name}/`));

function stageHostDeclarations() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const pending = ['release-host.d.ts', 'release-host-bootstrap.d.ts'];
  const copied = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (copied.has(name)) continue;
    const source = join(distRoot, name);
    if (!existsSync(source)) throw new Error(`PACKAGE_HOST_DECLARATION_MISSING:${name}`);
    const document = readFileSync(source, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gmu, '');
    const references = ts.preProcessFile(document, true, true);
    for (const reference of [...references.importedFiles, ...references.referencedFiles]) {
      const specifier = reference.fileName;
      if (specifier.startsWith('.')) {
        const dependency = resolve(dirname(source), specifier.replace(/\.js$/u, '.d.ts'));
        const relativePath = relative(distRoot, dependency).split(sep).join('/');
        if (relativePath.startsWith('../') || !relativePath.endsWith('.d.ts')) {
          throw new Error(`PACKAGE_HOST_DECLARATION_ESCAPE:${name}:${specifier}`);
        }
        pending.push(relativePath);
      } else {
        const dependency = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (
          !specifier.startsWith('node:') &&
          (workspacePackage.test(specifier) || manifest.dependencies?.[dependency] === undefined)
        ) {
          throw new Error(`PACKAGE_HOST_DECLARATION_PRIVATE_IMPORT:${name}:${specifier}`);
        }
      }
    }
    const target = join(declarationsRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      (name === 'release-host.d.ts' ? '/// <reference types="node" />\n' : '') + document,
    );
    copied.add(name);
  }
}

try {
  const verifierProvenance = validateVerifierAssets();
  const packagedSchemas = schemaClosure(schemaRoots);
  const codeBoundAssets = Object.fromEntries([
    ...packagedSchemas.map((name) => [
      `schemas/${name}`,
      readFileSync(join(repositoryRoot, 'law/schemas', name), 'utf8'),
    ]),
    [
      'sensor-registry.json',
      readFileSync(join(repositoryRoot, 'law/policy/sensor-registry.json'), 'utf8'),
    ],
  ]);
  stageHostDeclarations();
  writeFileSync(
    executablePath,
    readFileSync(join(distRoot, 'bin.js'), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gmu, ''),
  );
  const bundle = await rolldown({
    input: join(distRoot, 'release-host.js'),
    platform: 'node',
    external,
    plugins: [
      {
        name: 'bind-eager-package-assets-to-runtime-code',
        transform(code, id) {
          const selected =
            id === join(repositoryRoot, 'packages/schemas/dist/index.js')
              ? ['bundledPackageAssets', codeBoundAssets]
              : id === join(repositoryRoot, 'packages/sensors/dist/sensor-registry.js')
                ? ['bundledSensorRegistry', codeBoundAssets['sensor-registry.json']]
                : id === join(repositoryRoot, 'packages/sensors/dist/sense-presets.js')
                  ? [
                      'bundledSensePresets',
                      readFileSync(join(repositoryRoot, 'law/policy/sense-presets.json'), 'utf8'),
                    ]
                  : undefined;
          if (selected === undefined) return null;
          const [name, value] = selected;
          const pattern = new RegExp(`function ${name}\\(\\) \\{\\s*return undefined;\\s*\\}`, 'u');
          if (!pattern.test(code)) throw new Error(`PACKAGE_ASSET_BINDING_SOURCE_MISMATCH:${name}`);
          return {
            code: code.replace(
              pattern,
              () => `function ${name}() { return ${JSON.stringify(value)}; }`,
            ),
            map: null,
          };
        },
      },
      {
        name: 'relocate-packaged-operation-resources',
        transform(code, id) {
          if (id !== scaffoldModule) return null;
          const authored = '../../../resources/operations/scaffold';
          const packaged = '../../resources/operations/scaffold';
          if (!code.includes(authored)) throw new Error('PACKAGE_OPERATION_PATH_NOT_FOUND');
          return { code: code.replace(authored, packaged), map: null };
        },
      },
    ],
    resolve: {
      alias: {
        '#runtime-core': join(distRoot, 'runtime-core.js'),
      },
    },
    treeshake: true,
  });
  const output = await bundle.write({
    file: bundlePath,
    format: 'esm',
    codeSplitting: false,
    comments: false,
    sourcemap: false,
    banner: `import { createRequire as __devaiCreateRequire } from 'node:module';
import { fileURLToPath as __devaiFileURLToPath } from 'node:url';
import { dirname as __devaiDirname } from 'node:path';
const require = __devaiCreateRequire(import.meta.url);
const __filename = __devaiFileURLToPath(import.meta.url);
const __dirname = __devaiDirname(__filename);`,
  });
  const bootstrap = await rolldown({
    input: join(distRoot, 'release-host-bootstrap.js'),
    platform: 'node',
    external,
    treeshake: true,
  });
  const bootstrapOutput = await bootstrap.write({
    file: bootstrapPath,
    format: 'esm',
    codeSplitting: false,
    comments: false,
    sourcemap: false,
  });
  // Required dependencies are bundled; every remaining import is explicit.
  for (const item of [...output.output, ...bootstrapOutput.output]) {
    if (item.type !== 'chunk') continue;
    for (const dependency of [...item.imports, ...item.dynamicImports]) {
      if (dependency !== item.fileName && !external(dependency))
        throw new Error(`PACKAGE_HOST_UNCHECKED_IMPORT:${dependency}`);
    }
  }
  await bootstrap.close();
  const reachableSources = [
    ...new Set([
      'packages/cli/src/bin.ts',
      ...[...output.output, ...bootstrapOutput.output]
        .flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []))
        .filter(
          (id) => id.startsWith(`${repositoryRoot}/packages/`) && !id.includes('/node_modules/'),
        )
        .map((id) => {
          const sourceBase = id.replace('/dist/', '/src/').replace(/\.js$/u, '');
          const source = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
            .map((extension) => sourceBase + extension)
            .find((candidate) => existsSync(candidate));
          if (source === undefined) throw new Error(`PACKAGE_SOURCE_MAPPING_MISSING:${id}`);
          return source.slice(repositoryRoot.length + 1);
        }),
    ]),
  ].sort();
  const coverageManifest = join(repositoryRoot, 'scratch/coverage/rc-reachable-sources.json');
  mkdirSync(dirname(coverageManifest), { recursive: true });
  writeFileSync(
    coverageManifest,
    JSON.stringify({ schemaVersion: '1.0.0', sources: reachableSources }, null, 2) + '\n',
  );
  await bundle.close();

  rmSync(distRoot, { recursive: true, force: true });
  const runtimeRoot = join(distRoot, 'runtime');
  const runtimeIndex = join(runtimeRoot, 'index');
  mkdirSync(runtimeIndex, { recursive: true });
  cpSync(bundlePath, join(runtimeIndex, 'release-host.js'));
  cpSync(bootstrapPath, join(runtimeIndex, 'release-host-bootstrap.js'));
  cpSync(executablePath, join(runtimeIndex, 'bin.js'));
  cpSync(declarationsRoot, join(runtimeRoot, 'types/cli'), { recursive: true });
  chmodSync(join(runtimeIndex, 'bin.js'), 0o755);

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(runtimeRoot, 'package.json'),
    JSON.stringify({ type: 'module', version: manifest.version }, null, 2) + '\n',
  );
  mkdirSync(verifierRuntimeRoot, { recursive: true });
  copyFileSync(
    join(verifierSourceRoot, 'provenance.json'),
    join(verifierRuntimeRoot, 'provenance.json'),
  );
  for (const entry of verifierProvenance.files) {
    const target = join(verifierRuntimeRoot, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(verifierSourceRoot, entry.path), target);
  }
  for (const name of verifierBins) chmodSync(join(verifierRuntimeRoot, 'src', name), 0o755);

  copyFiles(join(repositoryRoot, 'law/schemas'), join(runtimeIndex, 'schemas'), packagedSchemas);
  // TypeScript is bundled, so its default library directory is now beside the
  // monolith. Preserve the complete compiler-owned declaration population.
  const compilerLibrariesRoot = dirname(ts.getDefaultLibFilePath({}));
  const compilerLibraries = readdirSync(compilerLibrariesRoot)
    .filter((name) => /^lib(?:\.[a-z0-9-]+)*\.d\.ts$/u.test(name))
    .sort();
  if (!compilerLibraries.includes('lib.d.ts'))
    throw new Error('PACKAGE_TYPESCRIPT_LIBRARIES_MISSING');
  copyFiles(compilerLibrariesRoot, runtimeIndex, compilerLibraries);
  writeFileSync(
    join(runtimeIndex, 'typescript-libraries.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0.0',
        compiler_version: ts.version,
        files: compilerLibraries.map((path) => ({
          path,
          sha256: sha256(join(compilerLibrariesRoot, path)),
        })),
      },
      null,
      2,
    ) + '\n',
  );

  // Bundling must retain the notices formerly supplied by dependency packages.
  const dependencyRoots = new Set(
    [...output.output, ...bootstrapOutput.output]
      .flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []))
      .filter((id) => id.includes('/node_modules/') && !id.startsWith('\0'))
      .map((id) => {
        const marker = id.lastIndexOf('/node_modules/') + '/node_modules/'.length;
        const suffix = id.slice(marker).split('/');
        return id.slice(0, marker) + suffix.slice(0, suffix[0].startsWith('@') ? 2 : 1).join('/');
      }),
  );
  for (const dependencyRoot of dependencyRoots) {
    const dependency = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8'));
    const names = readdirSync(dependencyRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(?:licen[cs]e|notice|copyright|thirdpartynoticetext)(?:[.-].*)?$/iu.test(entry.name),
      )
      .map((entry) => entry.name);
    if (names.length === 0) throw new Error(`PACKAGE_BUNDLED_LICENSE_MISSING:${dependency.name}`);
    const identity = `${dependency.name.replaceAll('/', '--')}@${dependency.version}`;
    copyFiles(dependencyRoot, join(runtimeRoot, 'licenses', identity), names);
  }
  copyFiles(join(repositoryRoot, 'law/policy'), runtimeIndex, [
    'sensor-registry.json',
    'round-execution.json',
    'sense-presets.json',
  ]);

  mkdirSync(join(distRoot, 'law'), { recursive: true });
  cpSync(join(repositoryRoot, 'law/constitution.md'), join(distRoot, 'law/constitution.md'));
  mkdirSync(join(runtimeRoot, 'law'), { recursive: true });
  cpSync(join(repositoryRoot, 'law/constitution.md'), join(runtimeRoot, 'law/constitution.md'));
  copyFiles(join(repositoryRoot, 'law/policy'), join(distRoot, 'law/policy'), policyFiles);
  cpSync(join(repositoryRoot, 'packages/skills/resources'), join(distRoot, 'resources'), {
    recursive: true,
  });

  const required = [
    join(runtimeIndex, 'bin.js'),
    join(runtimeIndex, 'release-host.js'),
    join(runtimeIndex, 'release-host-bootstrap.js'),
    join(runtimeRoot, 'types/cli/release-host-bootstrap.d.ts'),
    join(runtimeIndex, 'lib.d.ts'),
    join(runtimeIndex, 'typescript-libraries.json'),
    join(runtimeRoot, 'types/cli/release-host.d.ts'),
    join(runtimeIndex, 'schemas/action-result.schema.json'),
    join(runtimeIndex, 'schemas/release-plan-receipt-v2.schema.json'),
    join(runtimeIndex, 'schemas/release-policy-resolution.schema.json'),
    join(runtimeIndex, 'schemas/mutation-evidence-policy-v2.schema.json'),
    join(runtimeIndex, 'sensor-registry.json'),
    join(runtimeIndex, 'round-execution.json'),
    join(runtimeIndex, 'sense-presets.json'),
    ...verifierBins.map((name) => join(verifierRuntimeRoot, 'src', name)),
    join(verifierRuntimeRoot, 'schemas/task-descriptor.schema.json'),
    join(verifierRuntimeRoot, 'provenance.json'),
    join(distRoot, 'law/policy/github-issues-tracking.json'),
    join(distRoot, 'law/policy/trusted-local-rc-verifier-package.json'),
    join(distRoot, 'law/policy/mutation-evidence-v2.json'),
    join(distRoot, 'law/policy/release-lifecycle.json'),
    join(distRoot, 'law/constitution.md'),
    join(distRoot, 'resources/recipes/devai-round/SKILL.md'),
    join(distRoot, 'resources/operations/scaffold/templates/db/migration.sql.tpl'),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`PACKAGE_ASSET_MISSING:${missing.join(',')}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
