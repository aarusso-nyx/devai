#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_NAME = '@aarusso-nyx/devai';
const REPOSITORY = 'aarusso-nyx/devai';

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function json(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function assertPath(path, owner) {
  if (typeof path !== 'string' || !existsSync(join(ROOT, path))) {
    fail('PUBLISHABLE_DECLARED_PATH_MISSING', `${owner}:${String(path)}`);
  }
}

function assertSensorPaths(value, owner, key = '') {
  if (Array.isArray(value)) {
    if (key === 'source_paths') for (const path of value) assertPath(path, owner);
    else for (const item of value) assertSensorPaths(item, owner);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === 'emitter_module' || childKey === 'path') assertPath(child, owner);
    else assertSensorPaths(child, owner, childKey);
  }
}

const rootPackage = json('package.json');
const cliPackage = json('packages/cli/package.json');
if (cliPackage.name !== PACKAGE_NAME || !/^1\.1\.0(?:-rc\.\d+)?$/u.test(cliPackage.version)) {
  fail('PUBLISHABLE_PACKAGE_IDENTITY_INVALID', `${cliPackage.name}@${cliPackage.version}`);
}
if (cliPackage.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) {
  fail('PUBLISHABLE_REPOSITORY_IDENTITY_INVALID', String(cliPackage.repository?.url));
}
if (
  Object.values(cliPackage.dependencies ?? {}).some((value) =>
    String(value).startsWith('workspace:'),
  )
) {
  fail('PUBLISHABLE_RUNTIME_WORKSPACE_PROTOCOL', PACKAGE_NAME);
}

const packageManifests = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(join(ROOT, 'packages', entry.name, 'package.json')),
  )
  .map((entry) => json(`packages/${entry.name}/package.json`));
const publishable = packageManifests.filter((manifest) => manifest.private !== true);
if (publishable.length !== 1 || publishable[0]?.name !== PACKAGE_NAME) {
  fail('PUBLISHABLE_PACKAGE_SET_INVALID', publishable.map((item) => item.name).join(','));
}

const actions = json('law/policy/action-registry.json');
if (actions.entries?.length !== 43 || actions.counts?.total !== 43) {
  fail('PUBLISHABLE_ACTION_COUNT_INVALID', String(actions.entries?.length));
}
const actionIds = actions.entries.map((entry) => entry.action_id);
if (new Set(actionIds).size !== 43) fail('PUBLISHABLE_ACTION_ID_DUPLICATE', 'action-registry');
for (const entry of actions.entries) {
  for (const forbidden of ['previous_name', 'lifecycle', 'migration', 'disposition']) {
    if (Object.hasOwn(entry, forbidden))
      fail('PUBLISHABLE_ACTION_HISTORY_FIELD', `${entry.action_id}:${forbidden}`);
  }
}

const cliOutput = JSON.parse(
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'packages/cli/dist/runtime/index/bin.js'),
      'catalog',
      'actions',
      '--format',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ),
);
const runtimeActions = cliOutput?.result?.value;
if (!Array.isArray(runtimeActions)) fail('PUBLISHABLE_RUNTIME_CATALOG_MISSING', 'catalog actions');
const runtimeIds = runtimeActions.map((entry) => entry.name).sort();
if (JSON.stringify(runtimeIds) !== JSON.stringify([...actionIds].sort())) {
  fail('PUBLISHABLE_RUNTIME_CATALOG_DRIFT', `${runtimeIds.length}/${actionIds.length}`);
}

const sensors = json('law/policy/sensor-registry.json');
if (sensors.entries?.length !== 59)
  fail('PUBLISHABLE_SENSOR_COUNT_INVALID', String(sensors.entries?.length));
if (new Set(sensors.entries.map((entry) => entry.id)).size !== 59) {
  fail('PUBLISHABLE_SENSOR_ID_DUPLICATE', 'sensor-registry');
}
for (const sensor of sensors.entries) assertSensorPaths(sensor, sensor.id);

const recipeRoot = join(ROOT, 'packages/skills/resources/recipes');
const recipeNames = readdirSync(recipeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (recipeNames.length !== 7) fail('PUBLISHABLE_RECIPE_COUNT_INVALID', String(recipeNames.length));
const referencedOperations = new Set();
for (const name of recipeNames) {
  for (const file of ['SKILL.md', 'devai.recipe.json']) {
    assertPath(`packages/skills/resources/recipes/${name}/${file}`, name);
  }
  const manifest = json(`packages/skills/resources/recipes/${name}/devai.recipe.json`);
  for (const variant of Object.values(manifest.variants)) {
    for (const operation of variant.operations) referencedOperations.add(operation);
  }
}
const operationModule = await import(
  pathToFileURL(join(ROOT, 'packages/skills/dist/operations/catalog.js')).href
);
const implementedOperations = operationModule
  .listOperations()
  .map((operation) => operation.id)
  .sort();
const referenced = [...referencedOperations].sort();
if (JSON.stringify(implementedOperations) !== JSON.stringify(referenced)) {
  fail(
    'PUBLISHABLE_RECIPE_OPERATION_DRIFT',
    `${referenced.length}/${implementedOperations.length}`,
  );
}

const tasks = json('test-tasks.json');
if (tasks.repositoryId !== REPOSITORY)
  fail('PUBLISHABLE_LEDGER_REPOSITORY_INVALID', tasks.repositoryId);
for (const task of tasks.tasks) {
  if (task.argv?.[0] === 'pnpm' && task.argv?.[1] === 'run') {
    const script = task.argv[2];
    if (typeof rootPackage.scripts?.[script] !== 'string') {
      fail('PUBLISHABLE_TASK_SCRIPT_MISSING', `${task.nodeId}:${String(script)}`);
    }
  }
}

const suites = json('law/policy/check-suites.json');
const definedMembers = suites.member_definitions.map((entry) => entry.id).sort();
const referencedMembers = [...new Set(suites.suites.flatMap((suite) => suite.members))].sort();
if (
  JSON.stringify(definedMembers) !== JSON.stringify(['ledger-local', 'ledger-rc']) ||
  JSON.stringify(definedMembers) !== JSON.stringify(referencedMembers)
) {
  fail('PUBLISHABLE_CHECK_SUITE_POPULATION_INVALID', definedMembers.join(','));
}

const trackedPublicFiles = execFileSync('git', ['ls-files', '-z', 'docs', '.github/workflows'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path.length > 0 && existsSync(join(ROOT, path)));
const publicFiles = [
  'README.md',
  'CHANGELOG.md',
  '.github/SECURITY.md',
  ...trackedPublicFiles,
  ...filesUnder(join(ROOT, '.github/workflows')).map((path) => relative(ROOT, path)),
  ...filesUnder(join(ROOT, 'packages/cli/dist')).map((path) => relative(ROOT, path)),
];
const forbidden = [
  ['PUBLISHABLE_OLD_PACKAGE_IDENTITY', /@devai-nyx\/cli/u],
  ['PUBLISHABLE_OLD_REPOSITORY_IDENTITY', /devai-nyx\/devai\.git/u],
  ['PUBLISHABLE_OLD_VERSION', /1\.0\.0-rc\.1(?![0-9])/u],
  ['PUBLISHABLE_REMOVED_ROUTE', /init upgrade/u],
  ['PUBLISHABLE_REMOVED_PRESET_ALIAS', /SENSE_PRESET_RETIRED/u],
  ['PUBLISHABLE_COMPATIBILITY_TABLE', /old-to-new-command-map/u],
  ['PUBLISHABLE_CAMPAIGN_RECORD', /\bR-0007\b/u],
  ['PUBLISHABLE_CAMPAIGN_RECORD', /\bOM-019\b/u],
  ['PUBLISHABLE_CAMPAIGN_RECORD', /\bDII-257\b/u],
];
for (const path of publicFiles) {
  const source = readFileSync(join(ROOT, path), 'utf8');
  for (const [code, pattern] of forbidden) {
    if (pattern.test(source)) fail(code, `${path}:${String(pattern)}`);
  }
}

process.stdout.write(
  `${JSON.stringify({ package: `${PACKAGE_NAME}@${cliPackage.version}`, actions: 43, sensors: 59, recipes: 7, operations: referenced.length, publishable_packages: 1 })}\n`,
);
