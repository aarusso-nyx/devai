#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { ROSTER as schemaRoots } from '../../schemas/dist/roster.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const distRoot = join(packageRoot, 'dist');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-cli-assembly-'));
const bundlePath = join(temporaryRoot, 'bin.js');
const scaffoldModule = join(repositoryRoot, 'packages/skills/dist/operations/scaffold/index.js');

const policyFiles = [
  'action-registry.json',
  'check-suites.json',
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'model-runtime-registry.json',
  'mutation-strength.json',
  'round-execution.json',
  'scorecard-na.json',
  'sense-presets.json',
  'sensor-registry.json',
  'subprocess-effects.json',
  'thresholds.json',
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

const workspacePackage = /^@devai-nyx\//u;
const external = (id) =>
  id.startsWith('node:') ||
  (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('#') && !workspacePackage.test(id));

try {
  const bundle = await rolldown({
    input: join(distRoot, 'bin.js'),
    external,
    plugins: [
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
  });
  const reachableSources = output.output
    .flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []))
    .filter((id) => id.startsWith(repositoryRoot))
    .map((id) => {
      const sourceBase = id.replace('/dist/', '/src/').replace(/\.js$/u, '');
      const source = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
        .map((extension) => sourceBase + extension)
        .find((candidate) => existsSync(candidate));
      if (source === undefined) throw new Error(`PACKAGE_SOURCE_MAPPING_MISSING:${id}`);
      return source.slice(repositoryRoot.length + 1);
    })
    .sort();
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
  cpSync(bundlePath, join(runtimeIndex, 'bin.js'));
  chmodSync(join(runtimeIndex, 'bin.js'), 0o755);

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(runtimeRoot, 'package.json'),
    JSON.stringify({ type: 'module', version: manifest.version }, null, 2) + '\n',
  );

  const packagedSchemas = schemaClosure(schemaRoots);
  copyFiles(join(repositoryRoot, 'law/schemas'), join(runtimeIndex, 'schemas'), packagedSchemas);
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
    join(runtimeIndex, 'schemas/action-result.schema.json'),
    join(runtimeIndex, 'sensor-registry.json'),
    join(runtimeIndex, 'round-execution.json'),
    join(runtimeIndex, 'sense-presets.json'),
    join(distRoot, 'law/constitution.md'),
    join(distRoot, 'resources/recipes/devai-round/SKILL.md'),
    join(distRoot, 'resources/operations/scaffold/templates/db/migration.sql.tpl'),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`PACKAGE_ASSET_MISSING:${missing.join(',')}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
