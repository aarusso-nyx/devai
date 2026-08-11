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

export const ARCHITECT_ROOT_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md'] as const;

export const ENGINEER_ROOT_WORKSPACE_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.mjs',
] as const;
