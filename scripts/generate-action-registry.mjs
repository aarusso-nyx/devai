#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { format } from 'prettier';

const rootArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const root = resolve(rootArgument ?? '.');
const check = process.argv.includes('--check');
const sourceRelative = 'law/policy/action-registry.json';
const marker = '@generated from law/policy/action-registry.json';
const registry = JSON.parse(readFileSync(join(root, sourceRelative), 'utf8'));

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

if (!Array.isArray(registry.entries)) {
  throw new Error('ACTION_REGISTRY_COUNT_GUARD');
}
const actualCounts = { stable: 0, preview: 0, internal: 0, total: registry.entries.length };
const statusNames = ['stable', 'preview', 'internal'];
for (const entry of registry.entries) {
  if (!statusNames.includes(entry?.status)) {
    throw new Error('ACTION_REGISTRY_COUNT_GUARD');
  }
  actualCounts[entry.status] += 1;
}
const declaredCounts = registry.counts;
if (
  declaredCounts === null ||
  typeof declaredCounts !== 'object' ||
  Object.keys(declaredCounts).length !== Object.keys(actualCounts).length ||
  Object.keys(actualCounts).some(
    (status) =>
      !Number.isSafeInteger(declaredCounts[status]) ||
      declaredCounts[status] < 0 ||
      declaredCounts[status] !== actualCounts[status],
  ) ||
  declaredCounts.total !== registry.entries.length
) {
  throw new Error('ACTION_REGISTRY_COUNT_GUARD');
}
const ids = registry.entries.map((entry) => entry.action_id);
if (new Set(ids).size !== ids.length) throw new Error('ACTION_REGISTRY_ID_DUPLICATE');
if ([...ids].sort(compareUtf8Bytes).some((id, index) => id !== ids[index])) {
  throw new Error('ACTION_REGISTRY_ORDER_DRIFT');
}
for (const entry of registry.entries) {
  if (entry.action_id !== entry.path.join(' ')) {
    throw new Error('ACTION_PATH_DRIFT:' + entry.action_id);
  }
  if (
    entry.output_contract?.mode !== 'action-envelope' ||
    entry.error_contract?.mode !== 'structured-error-envelope'
  ) {
    throw new Error('ACTION_RESULT_CONTRACT_MISSING:' + entry.action_id);
  }
}

function generatedModule(preamble, valueName, value) {
  return (
    '// ' +
    marker +
    '\n// Do not edit; run node scripts/generate-action-registry.mjs.\n' +
    preamble +
    '\nexport const ' +
    valueName +
    ' = ' +
    JSON.stringify(value, null, 2) +
    ' as const;\n'
  );
}

const cliEntries = registry.entries.map((entry) => ({
  action_id: entry.action_id,
  handler: entry.handler,
  path: entry.path,
  status: entry.status,
  profiles: entry.profiles,
  effect: entry.effect,
  authority: entry.authority,
  description: entry.description,
  output_contract: entry.output_contract,
  error_contract: entry.error_contract,
  authority_contract_version: entry.authority_contract_version,
  authority_contract: entry.authority_contract,
}));
const effectEntries = registry.entries.map((entry) => ({
  action_id: entry.action_id,
  public_action_id: entry.action_id,
  effect: entry.effect,
  capabilities: entry.authority_contract.capabilities,
}));
const sensorEntries = registry.entries
  .filter((entry) => entry.authority === 'sensor')
  .map((entry) => ({
    action_id: entry.action_id,
    status: entry.status,
    effect: entry.effect,
  }));

const rawOutputs = new Map([
  [
    'packages/cli/src/generated/action-registry.ts',
    generatedModule(
      "import type { RegistryActionRecord } from '../command-manifest.js';",
      'ACTION_REGISTRY',
      cliEntries,
    ) +
      '\nexport const ACTION_REGISTRY_BY_HANDLER = new Map<string, RegistryActionRecord>();\n' +
      'for (const entry of ACTION_REGISTRY) {\n' +
      '  ACTION_REGISTRY_BY_HANDLER.set(entry.handler, entry);\n' +
      '}\n',
  ],
  [
    'packages/effects-check/src/generated/action-catalog.ts',
    generatedModule('', 'ACTION_EFFECT_CONTRACTS', effectEntries),
  ],
  [
    'packages/sensors/src/generated/action-kinds.ts',
    generatedModule('', 'SENSOR_ACTION_KINDS', sensorEntries),
  ],
]);

const outputs = new Map(
  await Promise.all(
    [...rawOutputs].map(async ([relative, bytes]) => [
      relative,
      await format(bytes, {
        parser: 'typescript',
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 100,
        tabWidth: 2,
        useTabs: false,
        endOfLine: 'lf',
        arrowParens: 'always',
      }),
    ]),
  ),
);

let stale = false;
for (const [relative, bytes] of outputs) {
  const target = join(root, relative);
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== bytes) {
      process.stderr.write('generated action view is stale: ' + relative + '\n');
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
if (stale) process.exitCode = 1;
else {
  process.stdout.write(
    String(outputs.size) + ' action registry views ' + (check ? 'verified' : 'generated') + '\n',
  );
}
