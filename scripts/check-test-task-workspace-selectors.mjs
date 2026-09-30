import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');
const descriptor = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((directory) => existsSync(join(root, 'packages', directory, 'package.json')));
const packages = new Map(
  packageDirs.map((directory) => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'),
    );
    return [manifest.name, { directory, manifest }];
  }),
);
const tasks = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));

// ADR-CHK-0006: the committed descriptor uses only the selector kinds the
// pinned trusted verifier admits, declared in its package policy. An
// unadmitted kind is refused before any rewrite, in both modes.
const VERIFIER_POLICY_PATH = 'law/policy/trusted-local-rc-verifier-package.json';
function admittedSelectorKinds() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(join(root, VERIFIER_POLICY_PATH), 'utf8'));
  } catch (error) {
    process.stderr.write(
      `TEST_TASK_SELECTOR_KINDS_UNDECLARED: ${VERIFIER_POLICY_PATH} is unreadable (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exit(1);
  }
  const kinds = policy?.descriptor?.selector_kinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    kinds.some((kind) => typeof kind !== 'string')
  ) {
    process.stderr.write(
      `TEST_TASK_SELECTOR_KINDS_UNDECLARED: ${VERIFIER_POLICY_PATH} declares no descriptor.selector_kinds\n`,
    );
    process.exit(1);
  }
  return new Set(kinds);
}
const admittedKinds = admittedSelectorKinds();
const unadmitted = [
  ...(descriptor.dynamicFallbackSelectors ?? []).map((selector) => [
    '<dynamicFallbackSelectors>',
    selector,
  ]),
  ...descriptor.tasks.flatMap((task) =>
    (task.inputSelectors ?? []).map((selector) => [task.nodeId, selector]),
  ),
].filter(([, selector]) => !admittedKinds.has(selector?.kind));
if (unadmitted.length > 0) {
  for (const [nodeId, selector] of unadmitted) {
    process.stderr.write(
      `TEST_TASK_SELECTOR_KIND_UNADMITTED: ${nodeId} uses selector kind ${String(selector?.kind)} (${String(selector?.pattern)}), outside descriptor.selector_kinds [${[...admittedKinds].join(', ')}] of ${VERIFIER_POLICY_PATH}\n`,
    );
  }
  process.exit(1);
}
const findings = [];
let changed = false;

function workspaceDependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
    .filter(([name, version]) => packages.has(name) && String(version).startsWith('workspace:'))
    .map(([name]) => name)
    .sort();
}

function taskForPackage(directory) {
  const direct = tasks.get(`test:${directory}`);
  if (direct !== undefined) return direct;
  return descriptor.tasks.find((task) => {
    const script = task.argv?.[0] === 'pnpm' && task.argv?.[1] === 'run' ? task.argv[2] : undefined;
    const command = script === undefined ? '' : String(rootManifest.scripts?.[script] ?? '');
    return command.includes(`packages/${directory}/tests`);
  });
}

function dependencyClosure(packageName) {
  const selected = new Set();
  const pending = workspaceDependencies(packages.get(packageName).manifest);
  for (let index = 0; index < pending.length; index += 1) {
    const dependency = pending[index];
    if (selected.has(dependency)) continue;
    selected.add(dependency);
    pending.push(...workspaceDependencies(packages.get(dependency).manifest));
  }
  return [...selected].sort();
}

for (const [packageName, { directory, manifest }] of packages) {
  const task = taskForPackage(directory);
  if (task === undefined) continue;
  const prefixes = new Set(
    task.inputSelectors
      .filter((selector) => selector.kind === 'prefix')
      .map((selector) => selector.pattern),
  );
  for (const dependencyName of dependencyClosure(packageName)) {
    const dependency = packages.get(dependencyName);
    const required = `packages/${dependency.directory}/`;
    if (!prefixes.has(required)) {
      if (checkOnly) findings.push(`${task.nodeId}: missing workspace selector ${required}`);
      else {
        task.inputSelectors.push({ kind: 'prefix', pattern: required });
        prefixes.add(required);
        changed = true;
      }
    }
  }

  const sourceRoot = join(root, 'packages', directory, 'src');
  if (!existsSync(sourceRoot)) continue;
  const declared = new Set(workspaceDependencies(manifest));
  for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\()\s*['"](@devai-nyx\/[^/'"]+)/gu)) {
      const imported = match[1];
      if (packages.has(imported) && !declared.has(imported)) {
        findings.push(`${relative(root, file)}: undeclared internal workspace import ${imported}`);
      }
    }
  }
}

if (!checkOnly && changed) {
  writeFileSync(join(root, 'test-tasks.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `test task workspace selectors: PASS (${String(packages.size)} packages checked${changed ? ', descriptor updated' : ''})\n`,
  );
}
