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
import { parseDocument } from 'yaml';

const packageRoot = resolve(import.meta.dirname, '..');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
const smokeRoot = mkdtempSync(join(tmpdir(), 'devai-installed-tarball-smoke-'));
const packRoot = join(smokeRoot, 'pack');
const projectRoot = join(smokeRoot, 'project');
const conflictRoot = join(smokeRoot, 'conflict-project');
const authorizationRoot = join(smokeRoot, 'authorization-project');

// Package-only acceptance invokes ['audit', 'scorecard'] and ['evidence', 'record'] below.

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
  const unexpectedPackedFiles = (packed.files ?? [])
    .map((file) => file.path)
    .filter(
      (path) =>
        path !== 'LICENSE' &&
        path !== 'package.json' &&
        !path.startsWith('dist/runtime/') &&
        !path.startsWith('dist/law/') &&
        !path.startsWith('dist/resources/'),
    );
  if (unexpectedPackedFiles.length > 0) {
    throw new Error(`PACK_DIST_CONTAMINATED:${unexpectedPackedFiles.slice(0, 10).join(',')}`);
  }

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
  if (unboundCatalog?.result?.value?.length !== 44) {
    throw new Error('INSTALLED_UNBOUND_CATALOG_INVALID');
  }
  const unboundPlan = JSON.parse(
    run(binary, ['init', 'plan', '--target', projectRoot, '--tier', 'tier1', '--format', 'json']),
  );
  if (unboundPlan?.result?.value?.summary?.create === undefined) {
    throw new Error('INSTALLED_UNBOUND_PLAN_INVALID');
  }
  if (
    !unboundPlan?.result?.value?.entries?.some(
      (entry) => entry.path === 'law/policy/mutation-strength.json',
    )
  ) {
    throw new Error('INSTALLED_MUTATION_POLICY_PLAN_MISSING');
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

  const authorityPolicyPath = join(projectRoot, '.devai/config/authority-policy.json');
  const initialPolicyDigest = JSON.parse(
    readFileSync(authorityPolicyPath, 'utf8'),
  ).resolved_digest_sha256;
  run(binary, ['--help']);
  for (const domain of [
    'audit',
    'catalog',
    'check',
    'doctor',
    'evidence',
    'init',
    'release',
    'round',
    'sense',
    'task',
    'triage',
  ]) {
    run(binary, [domain, '--help']);
  }
  run(binary, ['--help', '--all']);
  runResult(binary, ['doctor', '--repo-root', projectRoot, '--format', 'json']);
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
  const reboundPolicyDigest = JSON.parse(
    readFileSync(authorityPolicyPath, 'utf8'),
  ).resolved_digest_sha256;
  if (reboundPolicyDigest !== initialPolicyDigest) {
    throw new Error('INSTALLED_POLICY_DIGEST_INVOCATION_DRIFT');
  }

  const envelope = JSON.parse(run(binary, ['catalog', 'actions', '--format', 'json']));
  const actions = envelope?.result?.value;
  if (!Array.isArray(actions) || actions.length !== 44) {
    throw new Error(`INSTALLED_CATALOG_INVALID:${String(actions?.length)}`);
  }

  mkdirSync(join(projectRoot, 'work/rounds/R-0001'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'work/rounds/R-0001/record.md'),
    `---\nschemaVersion: '1.0.0'\nid: 'R-0001'\ntitle: 'Installed package RGR smoke'\ntype: 'validation'\nkind: 'validation'\nstatus: 'active'\ndate: '2026-08-13'\nauthority: 'Architect'\ngoal: 'Exercise the installed RGR control loop.'\ndeclared_by: 'installed-smoke'\nisolation:\n  kind: 'managed-worktree'\n  branch: 'installed-smoke'\n  base_sha: '${run('git', ['rev-parse', 'HEAD']).trim()}'\nwaves: []\ngates: []\norchestrator_prompt: 'record.md'\nplan_path: 'record.md'\n---\n`,
  );
  writeFileSync(
    join(projectRoot, 'work/rounds/R-0001/AUTHORIZATION.md'),
    `---\nschemaVersion: '1.0.0'\nround_id: 'R-0001'\nstatus: active\ndecision: GRANTED\nauthorized_by_role: Owner\nauthorized_at: '2026-08-13'\n---\n`,
  );
  mkdirSync(join(projectRoot, '.devai/state/tasks'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.devai/state/tasks/TASK-0001.json'),
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        id: 'TASK-0001',
        round_id: 'R-0001',
        status: 'queued',
        discipline: 'engineer',
        title: 'Installed RGR smoke task',
        target_modules: [],
        target_substrates: ['F2'],
        created_at: '2026-08-13T00:00:00.000Z',
        db_isolation: 'database',
        iteration_count: 0,
        executor: {
          kind: 'routine',
          argv: ['node', '--version'],
          cwd: '.',
          inputs: ['package.json'],
          outputs: [],
          effects: ['read'],
          timeout_ms: 10000,
          authority_checks: ['installed-package-rgr'],
        },
      },
      null,
      2,
    )}\n`,
  );
  const gap = JSON.parse(
    run(binary, [
      'round',
      'gap',
      'create',
      '--repo-root',
      projectRoot,
      '--round',
      'R-0001',
      '--task',
      'TASK-0001',
      '--discipline',
      'inspector',
      '--summary',
      'Installed package RGR smoke',
      '--ambiguity',
      'Verify the packaged RGR validator is callable.',
      '--evidence',
      'EV-INSTALLED-RGR-SMOKE',
      '--as-role',
      'inspector',
      '--write',
      '--format',
      'json',
    ]),
  );
  const gapId = gap?.result?.value?.id;
  if (
    typeof gapId !== 'string' ||
    !existsSync(join(projectRoot, `.devai/state/rgr/${gapId}.json`))
  ) {
    throw new Error('INSTALLED_RGR_CREATE_INVALID');
  }
  const resolvedGap = JSON.parse(
    run(binary, [
      'round',
      'gap',
      'resolve',
      gapId,
      '--repo-root',
      projectRoot,
      '--round',
      'R-0001',
      '--resolver',
      'installed-smoke-architect',
      '--status',
      'resolved',
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]),
  );
  if (resolvedGap?.result?.value?.status !== 'resolved') {
    throw new Error('INSTALLED_RGR_RESOLVE_INVALID');
  }
  run(binary, [
    'task',
    'start',
    '--repo-root',
    projectRoot,
    '--round',
    'R-0001',
    '--task',
    'TASK-0001',
    '--with-worktree',
    '--base-ref',
    'HEAD',
    '--as-role',
    'engineer',
    '--write',
    '--format',
    'json',
  ]);
  const roundRun = JSON.parse(
    run(binary, [
      'round',
      'run',
      '--repo-root',
      projectRoot,
      '--round',
      'R-0001',
      '--task',
      'TASK-0001',
      '--as-role',
      'engineer',
      '--write',
      '--format',
      'json',
    ]),
  );
  const taskExecutionId = roundRun?.result?.value?.results?.[0]?.evidence_id;
  if (
    roundRun?.result?.value?.ok !== true ||
    typeof taskExecutionId !== 'string' ||
    !existsSync(
      join(projectRoot, `.devai/state/round-runs/R-0001/task-executions/${taskExecutionId}.json`),
    ) ||
    JSON.parse(readFileSync(join(projectRoot, '.devai/state/tasks/TASK-0001.json'), 'utf8'))
      .status !== 'merging'
  ) {
    throw new Error('INSTALLED_ROUND_RUN_INVALID');
  }
  const finishedTask = JSON.parse(
    run(binary, [
      'task',
      'finish',
      '--repo-root',
      projectRoot,
      '--round',
      'R-0001',
      '--task',
      'TASK-0001',
      '--destroy-worktree',
      '--evidence',
      taskExecutionId,
      '--completed-by-role',
      'engineer',
      '--as-role',
      'engineer',
      '--write',
      '--format',
      'json',
    ]),
  );
  if (
    finishedTask?.result?.value?.status !== 'completed' ||
    JSON.parse(readFileSync(join(projectRoot, '.devai/state/worktrees.json'), 'utf8')).worktrees
      .length !== 0 ||
    existsSync(join(projectRoot, '.devai/worktrees/WT-TASK-0001'))
  ) {
    throw new Error('INSTALLED_ROUND_FINISH_INVALID');
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

  const adopterPolicyPath = join(projectRoot, 'law/policy/adopter-policy.json');
  mkdirSync(join(projectRoot, 'law/policy'), { recursive: true });
  const projectPath = join(projectRoot, '.devai/config/project.json');
  const projectBeforeDocs = JSON.parse(readFileSync(projectPath, 'utf8'));
  writeFileSync(
    projectPath,
    `${JSON.stringify(
      {
        ...projectBeforeDocs,
        feature_flags: { adopter_owned_toggle: true },
        docs: { builder: 'docusaurus', output_dir: 'site/build' },
      },
      null,
      2,
    )}\n`,
  );
  const validAdopterPolicyBytes = `${JSON.stringify(
    {
      schemaVersion: '1.0.0',
      policy_id: 'installed-smoke',
      policy_version: '1.0.0',
      domains: { client: ['COVERAGE'] },
      thresholds: { coverage: { lines: 91 } },
      project: {
        docs: {
          builder: 'docusaurus',
          publish_target: 'gh-pages',
          gh_pages_branch: 'gh-pages',
        },
      },
      ci_economy: {
        attested_rc: {
          profile: 'rc',
          transport: 'protected-tag-v1',
          tag_prefix: 'devai-local-evidence/',
          binding: 'exact-tree',
          required_check: 'verified-local-rc',
          failure_mode: 'fail-closed',
          local_only_nodes: ['test:mutation'],
        },
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(adopterPolicyPath, validAdopterPolicyBytes);
  run(binary, [
    'init',
    'bind',
    '--adopter-policy',
    'law/policy/adopter-policy.json',
    '--target',
    projectRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  const adopterTargets = [
    '.devai/config/project.json',
    '.devai/config/domains.json',
    '.devai/config/thresholds.json',
    '.devai/config/scorecard-na.json',
    '.devai/config/glob-guards.json',
    '.devai/config/adopter-policy-binding.json',
  ];
  const adopterSnapshot = new Map(
    adopterTargets.map((path) => [path, readFileSync(join(projectRoot, path), 'utf8')]),
  );
  const boundProject = JSON.parse(
    readFileSync(join(projectRoot, '.devai/config/project.json'), 'utf8'),
  );
  if (
    boundProject.ci_economy?.attested_rc?.required_check !== 'verified-local-rc' ||
    boundProject.ci_economy?.attested_rc?.local_only_nodes?.join(',') !== 'test:mutation' ||
    boundProject.feature_flags?.adopter_owned_toggle !== true ||
    boundProject.docs?.output_dir !== 'site/build' ||
    boundProject.docs?.publish_target !== 'gh-pages' ||
    boundProject.docs?.gh_pages_branch !== 'gh-pages'
  ) {
    throw new Error('INSTALLED_ADOPTER_POLICY_ATTESTED_RC_INVALID');
  }
  writeFileSync(
    adopterPolicyPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      policy_id: 'installed-smoke',
      policy_version: '1.0.1',
      domains: { client: ['CORE'] },
    })}\n`,
  );
  const refusedAdopterPolicy = runResult(binary, [
    'init',
    'bind',
    '--adopter-policy',
    'law/policy/adopter-policy.json',
    '--target',
    projectRoot,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  if (
    refusedAdopterPolicy.status === 0 ||
    adopterTargets.some(
      (path) => readFileSync(join(projectRoot, path), 'utf8') !== adopterSnapshot.get(path),
    )
  ) {
    throw new Error('INSTALLED_ADOPTER_POLICY_ROLLBACK_INVALID');
  }
  writeFileSync(adopterPolicyPath, validAdopterPolicyBytes);

  run('git', ['remote', 'add', 'origin', 'https://github.com/example/adopter.git']);
  for (const adapter of ['github-actions', 'post-merge']) {
    run(binary, [
      'init',
      'bind',
      '--host-adapter',
      adapter,
      '--target',
      projectRoot,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
  }
  const githubWorkflow = readFileSync(
    join(projectRoot, '.github/workflows/devai-main-observation.yml'),
    'utf8',
  );
  if (parseDocument(githubWorkflow).errors.length > 0) {
    throw new Error('INSTALLED_GITHUB_ACTIONS_WORKFLOW_SYNTAX_INVALID');
  }
  const adapterDoctor = runResult(binary, [
    'doctor',
    '--repo-root',
    projectRoot,
    '--format',
    'json',
  ]);
  const authorityCheck = JSON.parse(String(adapterDoctor.stdout))?.result?.value?.checks?.find(
    (check) => check.name === 'authority-enforcement',
  );
  if (
    ![0, 1].includes(adapterDoctor.status) ||
    authorityCheck?.ok !== true ||
    authorityCheck?.info?.selected_adapter_policy_bound !== true ||
    authorityCheck?.info?.local_post_merge_enforced !== true ||
    authorityCheck?.info?.github_actions_enforced !== true ||
    authorityCheck?.info?.github_actions_facts?.workflow_syntax_valid !== true ||
    authorityCheck?.info?.arbitrary_host_tools_enforced !== false
  ) {
    throw new Error('INSTALLED_HOST_ADAPTER_DIAGNOSIS_INVALID');
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

  const blueprintPath = join(projectRoot, 'module-blueprint.json');
  writeFileSync(
    blueprintPath,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        id: 'BP-TEAT-001',
        module: { name: 'Teat', namespace: 'teat', version: '1.0.0' },
        database: {
          entities: [{ name: 'Receipt', fields: [{ name: 'id', type: 'uuid' }] }],
        },
      },
      null,
      2,
    )}\n`,
  );
  const blueprintCheck = JSON.parse(
    run(binary, [
      'check',
      '--only',
      'blueprint',
      '--file',
      blueprintPath,
      '--repo-root',
      projectRoot,
      '--format',
      'json',
    ]),
  );
  if (blueprintCheck?.result?.value?.ok !== true) {
    throw new Error('INSTALLED_BLUEPRINT_CHECK_INVALID');
  }
  const schemaCheck = JSON.parse(
    run(binary, ['check', '--only', 'schemas', '--repo-root', projectRoot, '--format', 'json']),
  );
  if (
    schemaCheck?.result?.value?.mode !== 'adopter-binding' ||
    schemaCheck?.result?.value?.ok !== true
  ) {
    throw new Error('INSTALLED_ADOPTER_SCHEMA_CHECK_INVALID');
  }
  if (!existsSync(join(projectRoot, 'law/policy/mutation-strength.json'))) {
    throw new Error('INSTALLED_MUTATION_POLICY_MISSING');
  }
  mkdirSync(join(projectRoot, 'law/invariants'), { recursive: true });
  mkdirSync(join(projectRoot, '.devai/state/mutation'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'law/invariants/INV-TEAT-001.json'),
    `${JSON.stringify({ id: 'INV-TEAT-001', verification: { strategy: 'mutation' } })}\n`,
  );
  writeFileSync(
    join(projectRoot, '.devai/state/mutation/current.json'),
    `${JSON.stringify({ mutation_score: 100, survived: 0 })}\n`,
  );
  const mutationCheck = JSON.parse(
    run(binary, ['check', '--only', 'mutation', '--repo-root', projectRoot, '--format', 'json']),
  );
  if (mutationCheck?.result?.value?.ok !== true) {
    throw new Error('INSTALLED_MUTATION_CHECK_INVALID');
  }
  run(binary, [
    'evidence',
    'record',
    '--kind',
    'generic',
    '--round',
    'R-0013',
    '--repo-root',
    projectRoot,
    '--payload',
    '{"installed":true}',
    '--as-role',
    'auditor',
    '--write',
    '--format',
    'json',
  ]);
  const chain = JSON.parse(readFileSync(join(projectRoot, 'record/proofs/chain.json'), 'utf8'));
  if (chain?.records?.length !== 1 || chain.records[0]?.previous_hash !== 'GENESIS') {
    throw new Error('INSTALLED_FRESH_CHAIN_GENESIS_INVALID');
  }
  const chainVerification = JSON.parse(
    run(binary, [
      'evidence',
      'verify',
      '--scope',
      'chain',
      '--repo-root',
      projectRoot,
      '--format',
      'json',
    ]),
  );
  if (chainVerification?.result?.value?.valid !== true) {
    throw new Error('INSTALLED_FRESH_CHAIN_VERIFY_INVALID');
  }
  const scorecardHead = run('git', ['rev-parse', 'HEAD']).trim();
  const scorecardFirst = run(binary, [
    'audit',
    'scorecard',
    '--repo-root',
    projectRoot,
    '--at',
    scorecardHead,
    '--format',
    'json',
  ]);
  const scorecardSecond = run(binary, [
    'audit',
    'scorecard',
    '--repo-root',
    projectRoot,
    '--at',
    scorecardHead,
    '--format',
    'json',
  ]);
  if (scorecardFirst !== scorecardSecond) {
    throw new Error('INSTALLED_SCORECARD_NONDETERMINISTIC');
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
  mkdirSync(authorizationRoot, { recursive: true });
  run('git', ['init', '-q'], authorizationRoot);
  run('git', ['config', 'user.email', 'smoke@example.invalid'], authorizationRoot);
  run(
    binary,
    [
      'init',
      'bind',
      '--constitution',
      '--tier',
      'tier1',
      '--target',
      authorizationRoot,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    authorizationRoot,
  );
  run(
    binary,
    [
      'init',
      'bind',
      '--target',
      authorizationRoot,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    authorizationRoot,
  );
  writeFileSync(
    join(authorizationRoot, '.devai/config/forbidden-actions.json'),
    readFileSync(join(installedPackage, 'dist/law/policy/forbidden-actions.json')),
  );
  run('git', ['add', '.devai'], authorizationRoot);
  run(
    'git',
    ['-c', 'user.name=DEVAI Architect', 'commit', '-qm', 'seed forbidden policy'],
    authorizationRoot,
  );
  writeFileSync(join(authorizationRoot, 'unsafe.txt'), 'git push --force\n');
  run('git', ['add', 'unsafe.txt'], authorizationRoot);
  run(
    'git',
    ['-c', 'user.name=Fixture', 'commit', '-qm', 'fixture unsafe evidence'],
    authorizationRoot,
  );
  const authorizedCommit = run('git', ['rev-parse', 'HEAD'], authorizationRoot).trim();
  mkdirSync(join(authorizationRoot, 'law/policy'), { recursive: true });
  writeFileSync(
    join(authorizationRoot, 'law/policy/forbidden-action-authorizations.json'),
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        authorizations: [
          {
            forbidden_id: 'FORBID-FORCE-PUSH',
            commit: authorizedCommit,
            authorized_by: 'Owner',
            reason: 'Owner approved this exact installed-package fixture commit.',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  run('git', ['add', 'law/policy/forbidden-action-authorizations.json'], authorizationRoot);
  run(
    'git',
    ['-c', 'user.name=DEVAI Architect', 'commit', '-qm', 'record exact authorization'],
    authorizationRoot,
  );
  const authorizedCheck = JSON.parse(
    run(
      binary,
      [
        'check',
        '--only',
        'forbidden-actions',
        '--strict',
        '--max-commits',
        '2',
        '--format',
        'json',
      ],
      authorizationRoot,
    ),
  );
  if (
    authorizedCheck?.result?.value?.ok !== true ||
    authorizedCheck?.result?.value?.authorization_receipts?.applied?.[0] !==
      `FORBID-FORCE-PUSH@${authorizedCommit}`
  ) {
    throw new Error('INSTALLED_EXACT_FORBIDDEN_AUTHORIZATION_INVALID');
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
  const adoptionCommit = run('git', ['rev-parse', 'HEAD'], projectRoot).trim();
  writeFileSync(
    join(projectRoot, 'law/policy/forbidden-action-authorizations.json'),
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        authorizations: [
          {
            forbidden_id: 'FORBID-MUTATE-INVARIANTS',
            commit: adoptionCommit,
            authorized_by: 'Owner',
            reason: 'Fixture Owner authorizes this exact installed-package materialization commit.',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  run('git', ['add', 'law/policy/forbidden-action-authorizations.json'], projectRoot);
  run(
    'git',
    ['-c', 'user.name=DEVAI Architect', 'commit', '-qm', 'authorize adoption materialization'],
    projectRoot,
  );
  const remoteRoot = join(smokeRoot, 'remote.git');
  run('git', ['init', '--bare', '-q', remoteRoot], smokeRoot);
  run('git', ['remote', 'set-url', 'origin', remoteRoot], projectRoot);
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
    throw new Error('SOURCE_BOUNDARY: workspace protocol forbidden');
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
      44
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
