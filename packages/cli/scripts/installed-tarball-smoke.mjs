#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
const smokeRoot = mkdtempSync(join(tmpdir(), 'devai-installed-tarball-smoke-'));
const packRoot = join(smokeRoot, 'pack');
const projectRoot = join(smokeRoot, 'project');
const conflictRoot = join(smokeRoot, 'conflict-project');

function run(command, args, cwd = projectRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runResult(command, args, cwd = projectRoot) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

try {
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const packed = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', packRoot], packageRoot),
  );
  const tarball = packed?.filename;
  if (typeof tarball !== 'string') throw new Error('PACK_TARBALL_MISSING');

  run('pnpm', ['init'], projectRoot);
  run('git', ['init', '-q'], projectRoot);
  run('pnpm', ['add', '--prefer-offline', resolve(packageRoot, tarball)], projectRoot);
  writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n.devai/state/\nscratch/\n');
  run('git', ['config', 'user.name', 'DEVAI smoke'], projectRoot);
  run('git', ['config', 'user.email', 'smoke@example.invalid'], projectRoot);
  run('git', ['add', 'package.json', 'pnpm-lock.yaml', '.gitignore'], projectRoot);
  run('git', ['commit', '-qm', 'installed package fixture'], projectRoot);
  const binary = join(projectRoot, 'node_modules/.bin/devai');
  const installedPackage = join(projectRoot, 'node_modules/@aarusso-nyx/devai');

  const version = run(binary, ['--version']).trim();
  if (!version.startsWith(`devai/${packageVersion} `)) {
    throw new Error(`INSTALLED_VERSION_INVALID:${version}`);
  }
  const help = run(binary, ['--help']);
  if (!help.includes('Usage: devai <command>')) throw new Error('INSTALLED_HELP_INVALID');

  const unboundCatalog = JSON.parse(run(binary, ['catalog', 'actions', '--format', 'json']));
  if (unboundCatalog?.result?.value?.length !== 41) {
    throw new Error('INSTALLED_UNBOUND_CATALOG_INVALID');
  }
  const unboundPlan = JSON.parse(
    run(binary, ['init', 'plan', '--target', projectRoot, '--tier', 'tier1', '--format', 'json']),
  );
  if (unboundPlan?.result?.value?.summary?.create === undefined) {
    throw new Error('INSTALLED_UNBOUND_PLAN_INVALID');
  }
  const unboundDoctor = runResult(binary, [
    'doctor',
    '--repo-root',
    projectRoot,
    '--format',
    'json',
  ]);
  const doctorEnvelope = JSON.parse(String(unboundDoctor.stdout));
  if (unboundDoctor.status !== 1 || doctorEnvelope?.result?.verdict !== 'review') {
    throw new Error('INSTALLED_UNBOUND_DOCTOR_INVALID');
  }

  run(binary, [
    'init',
    'bind',
    '--constitution',
    '--tier',
    'tier1',
    '--target',
    projectRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  for (const contract of ['--operational-law', '--subprocess-effects']) {
    run(binary, [
      'init',
      'bind',
      contract,
      '--target',
      projectRoot,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
  }
  run(binary, [
    'init',
    'bind',
    '--target',
    projectRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  const bindingFiles = [
    '.devai/pin/constitution.md',
    '.devai/constitution.md',
    '.devai/config/project.json',
    '.devai/config/authority-policy.json',
  ];
  if (bindingFiles.some((path) => !existsSync(join(projectRoot, path)))) {
    throw new Error('INSTALLED_BINDING_ASSET_MISSING');
  }
  if (lstatSync(join(projectRoot, '.devai/constitution.md')).isSymbolicLink()) {
    throw new Error('INSTALLED_CONSTITUTION_POINTER_SYMLINK');
  }

  const envelope = JSON.parse(run(binary, ['catalog', 'actions', '--format', 'json']));
  const actions = envelope?.result?.value;
  if (!Array.isArray(actions) || actions.length !== 41) {
    throw new Error(`INSTALLED_CATALOG_INVALID:${String(actions?.length)}`);
  }

  for (const segment of ['owner', 'architect']) {
    run(binary, [
      'init',
      'apply',
      segment,
      '--tier',
      'tier1',
      '--target',
      projectRoot,
      '--as-role',
      segment,
      '--write',
      '--format',
      'json',
    ]);
  }

  const installArgs = [
    'init',
    'apply',
    'harness',
    '--include',
    'skills',
    '--target',
    projectRoot,
    '--tier',
    'tier1',
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ];
  const installedOnce = JSON.parse(run(binary, installArgs));
  const installedTwice = JSON.parse(run(binary, installArgs));
  const firstSkills = installedOnce?.result?.value?.included?.find(
    (entry) => entry.component === 'skills',
  )?.result;
  const secondSkills = installedTwice?.result?.value?.included?.find(
    (entry) => entry.component === 'skills',
  )?.result;
  if (firstSkills?.written?.length !== 49 || secondSkills?.unchanged?.length !== 49) {
    throw new Error('INSTALLED_RECIPE_ADAPTER_IDEMPOTENCE_INVALID');
  }

  mkdirSync(conflictRoot, { recursive: true });
  run('git', ['init', '-q'], conflictRoot);
  run(binary, [
    'init',
    'bind',
    '--constitution',
    '--tier',
    'tier1',
    '--target',
    conflictRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  run(binary, [
    'init',
    'bind',
    '--target',
    conflictRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  const conflictingSkill = join(conflictRoot, '.agents/skills/devai-assess/SKILL.md');
  mkdirSync(join(conflictingSkill, '..'), { recursive: true });
  writeFileSync(conflictingSkill, 'adopter-owned conflict\n');
  const refusedApply = runResult(binary, [
    'init',
    'apply',
    'harness',
    '--tier',
    'tier1',
    '--include',
    'skills',
    '--target',
    conflictRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  if (
    refusedApply.status === 0 ||
    existsSync(join(conflictRoot, '.gitignore')) ||
    existsSync(join(conflictRoot, 'record/proofs/chain.json')) ||
    readFileSync(conflictingSkill, 'utf8') !== 'adopter-owned conflict\n'
  ) {
    throw new Error('INSTALLED_APPLY_PREFLIGHT_ROLLBACK_INVALID');
  }

  const packagedCheck = JSON.parse(
    run(binary, ['check', '--only', 'forbidden-actions', '--strict', '--format', 'json']),
  );
  if (packagedCheck?.result?.value?.ok !== true) {
    throw new Error('INSTALLED_PACKAGED_CHECK_POLICY_INVALID');
  }
  const missingDescriptor = runResult(binary, [
    'check',
    '--affected',
    '--task-plan',
    '--base',
    '0'.repeat(40),
    '--format',
    'json',
  ]);
  if (
    missingDescriptor.status !== 5 ||
    !String(missingDescriptor.stderr).includes('CHECK_TASK_DESCRIPTOR_MISSING')
  ) {
    throw new Error('INSTALLED_TASK_DESCRIPTOR_DIAGNOSTIC_INVALID');
  }

  run(binary, [
    'init',
    'apply',
    'architect',
    '--tier',
    'tier1',
    '--include',
    'hooks',
    '--target',
    projectRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  const prePush = join(projectRoot, '.git/hooks/pre-push');
  if (
    !readFileSync(prePush, 'utf8').includes(
      './node_modules/.bin/devai check --only forbidden-actions --strict',
    )
  ) {
    throw new Error('INSTALLED_PROJECT_LOCAL_HOOK_INVALID');
  }
  run('git', ['add', '.agents', '.claude', '.devai', 'record'], projectRoot);
  run('git', ['commit', '-qm', 'adopt DEVAI'], projectRoot);
  const remoteRoot = join(smokeRoot, 'remote.git');
  run('git', ['init', '--bare', '-q', remoteRoot], smokeRoot);
  run('git', ['remote', 'add', 'origin', remoteRoot], projectRoot);
  run('git', ['push', '-q', '-u', 'origin', 'HEAD:main'], projectRoot);

  const representatives = [
    ['catalog', 'actions'],
    ['check'],
    ['doctor'],
    ['evidence', 'verify'],
    ['init', 'plan'],
    ['release', 'status'],
    ['round', 'status'],
    ['sense', 'inventory'],
    ['task', 'status'],
  ];
  for (const action of representatives) {
    const output = run(binary, [...action, '--help']);
    if (!output.includes(`Usage: devai ${action.join(' ')}`)) {
      throw new Error(`INSTALLED_DOMAIN_HELP_INVALID:${action.join(' ')}`);
    }
  }

  const packageJson = JSON.parse(readFileSync(join(installedPackage, 'package.json'), 'utf8'));
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});
  if (dependencyNames.some((name) => name.startsWith('@devai-nyx/'))) {
    throw new Error('INSTALLED_DEVAI_RUNTIME_DEPENDENCY');
  }
  if (JSON.stringify(packageJson).includes('workspace:*')) {
    throw new Error('INSTALLED_WORKSPACE_PROTOCOL');
  }

  const recipeRoot = join(installedPackage, 'dist/resources/recipes');
  const recipes = filesUnder(recipeRoot).filter((path) => path.endsWith('/SKILL.md'));
  const templates = filesUnder(
    join(installedPackage, 'dist/resources/operations/scaffold/templates'),
  );
  const schemas = filesUnder(join(installedPackage, 'dist/runtime/index/schemas'));
  const requiredAssets = [
    'dist/law/policy/action-registry.json',
    'dist/law/policy/sensor-registry.json',
    'dist/runtime/index/round-execution.json',
    'dist/runtime/index/sense-presets.json',
    'dist/runtime/index/sensor-registry.json',
    'dist/runtime/law/constitution.md',
  ];
  if (recipes.length !== 7) throw new Error(`INSTALLED_RECIPE_COUNT_INVALID:${recipes.length}`);
  for (const skillPath of recipes) {
    const name = skillPath.split('/').at(-2);
    if (typeof name !== 'string') throw new Error('INSTALLED_RECIPE_NAME_MISSING');
    const sourceBase = join(recipeRoot, name);
    const codexBase = join(projectRoot, '.agents/skills', name);
    const claudeBase = join(projectRoot, '.claude/skills', name);
    for (const targetBase of [codexBase, claudeBase]) {
      for (const file of ['SKILL.md', 'devai.recipe.json', 'devai.operations.json']) {
        if (!existsSync(join(targetBase, file))) {
          throw new Error(`INSTALLED_RECIPE_ADAPTER_ASSET_MISSING:${name}:${file}`);
        }
      }
      if (readFileSync(join(targetBase, 'SKILL.md'), 'utf8') !== readFileSync(skillPath, 'utf8')) {
        throw new Error(`INSTALLED_RECIPE_SKILL_PARITY_INVALID:${name}`);
      }
      if (
        readFileSync(join(targetBase, 'devai.recipe.json'), 'utf8') !==
        readFileSync(join(sourceBase, 'devai.recipe.json'), 'utf8')
      ) {
        throw new Error(`INSTALLED_RECIPE_MANIFEST_PARITY_INVALID:${name}`);
      }
    }
    if (
      readFileSync(join(codexBase, 'devai.operations.json'), 'utf8') !==
      readFileSync(join(claudeBase, 'devai.operations.json'), 'utf8')
    ) {
      throw new Error(`INSTALLED_RECIPE_OPERATION_PARITY_INVALID:${name}`);
    }
    const manifest = JSON.parse(readFileSync(join(sourceBase, 'devai.recipe.json'), 'utf8'));
    const descriptor = JSON.parse(readFileSync(join(codexBase, 'devai.operations.json'), 'utf8'));
    const referenced = [
      ...new Set(Object.values(manifest.variants).flatMap((variant) => variant.operations)),
    ].sort();
    const described = descriptor.operations.map((operation) => operation.id).sort();
    if (JSON.stringify(referenced) !== JSON.stringify(described)) {
      throw new Error(`INSTALLED_RECIPE_OPERATION_CENSUS_INVALID:${name}`);
    }
    const metadata = readFileSync(join(codexBase, 'agents/openai.yaml'), 'utf8');
    const expectedImplicit = manifest.status === 'preview' ? 'false' : 'true';
    if (!metadata.includes(`allow_implicit_invocation: ${expectedImplicit}`)) {
      throw new Error(`INSTALLED_RECIPE_INVOCATION_POLICY_INVALID:${name}`);
    }
  }
  if (templates.length !== 19) {
    throw new Error(`INSTALLED_TEMPLATE_COUNT_INVALID:${templates.length}`);
  }
  if (requiredAssets.some((path) => !existsSync(join(installedPackage, path)))) {
    throw new Error('INSTALLED_RUNTIME_ASSET_MISSING');
  }

  for (const path of [
    '.agents/skills',
    '.claude/skills',
    '.devai',
    'record/proofs',
    'record/derived/inventory',
    'scratch/worktrees',
    '.git/hooks/pre-push',
  ]) {
    rmSync(join(projectRoot, path), { recursive: true, force: true });
  }
  if (
    existsSync(join(projectRoot, '.agents/skills/devai-assess')) ||
    existsSync(join(projectRoot, '.devai')) ||
    JSON.parse(run(binary, ['catalog', 'actions', '--format', 'json']))?.result?.value?.length !==
      41
  ) {
    throw new Error('INSTALLED_REMOVAL_PROCEDURE_INVALID');
  }
  const tarballPath = resolve(packageRoot, tarball);
  const installedFiles = filesUnder(installedPackage);

  process.stdout.write(
    JSON.stringify({
      tarball: tarballPath,
      tarball_bytes: statSync(tarballPath).size,
      packed_files: packed.files?.length,
      installed_bytes: installedFiles.reduce((total, path) => total + statSync(path).size, 0),
      version,
      actions: actions.length,
      domains: representatives.length,
      recipes: recipes.length,
      templates: templates.length,
      schemas: schemas.length,
      runtime_dependencies: dependencyNames.sort(),
    }) + '\n',
  );
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
