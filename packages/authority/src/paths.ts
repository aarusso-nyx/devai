export const AUTHORITY_CONSTITUTION_PATH = 'law/constitution.md' as const;
export const AUTHORITY_POLICY_MATERIALIZED_PATH = '.devai/config/authority-policy.json' as const;

export const STATIC_AUTHORITY_PREFIXES = [
  { prefix: 'law/glossary/', authority: ['owner', 'architect'] },
  { prefix: 'law/', authority: ['architect'] },
  { prefix: 'product/', authority: ['owner'] },
  { prefix: 'work/rounds/', authority: ['architect'] },
  { prefix: 'work/audit/', authority: ['auditor'] },
  { prefix: 'docs/', authority: ['architect'] },
  { prefix: 'record/', authority: ['machine'] },
  { prefix: '.devai/pin/', authority: ['binding'] },
  { prefix: '.devai/config/', authority: ['binding'] },
  { prefix: '.devai/state/', authority: ['executing-verb'] },
  { prefix: 'packages/', authority: ['engineer'] },
  { prefix: 'tests/', authority: ['inspector'] },
  { prefix: 'scratch/', authority: ['ephemeral'] },
] as const;

export const INSPECTOR_TEST_DIRECTORY_SEGMENT = 'tests' as const;

/**
 * The one verb the Engineer holds on the test class (Articles 6 and 7 at constitution 1.1.0,
 * ADR-GOV-0026): add a focused regression test, or modify one the task added, when the test
 * imports a source the same task changed. It is enforced from this table by the diff-time
 * adjacency check of a governed task, not by the action registry.
 */
export const ENGINEER_TEST_CLASS_VERB = Object.freeze({
  verb: 'add-or-modify-focused',
  role: 'engineer',
  path_class: 'test',
  min_constitution: '1.1.0',
} as const);

/** A test file of the test class; configuration, helpers and fixtures there are not tests. */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export const ARCHITECT_ROOT_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md'] as const;

export const ENGINEER_ROOT_WORKSPACE_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.mjs',
] as const;
