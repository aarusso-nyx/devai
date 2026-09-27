const ROOT_ARCHITECT_PATHS = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md']);
const DECISION_REGISTER_PATH = 'law/register/DECISIONS.md';

export type TranslationAuthorityRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type MutationAuthorityRole = Exclude<TranslationAuthorityRole, 'auditor'>;

export type TranslationFilesystemEffect =
  | 'fs:owner-spec'
  | 'fs:architect-spec'
  | 'fs:tests'
  | 'fs:plant'
  | 'fs:auditor-observation'
  | 'fs:proofs'
  | 'fs:inventory'
  | 'fs:f5-config'
  | 'fs:f5-state'
  | 'fs:worktree-admin';

export interface TranslationPathClassification {
  readonly allowed: boolean;
  readonly effect: TranslationFilesystemEffect;
}

function isTestAuthorityPath(path: string): boolean {
  return (
    /(^|\/)(?:test|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
    /(^|\/)(?:vitest(?:\.[^/]*)?|jest|playwright|cypress)\.config\.[cm]?[jt]s$/u.test(path)
  );
}

export function classifyTranslationPath(
  role: TranslationAuthorityRole,
  path: string,
): TranslationPathClassification {
  const testPath = isTestAuthorityPath(path);
  const auditorObservation = path === 'work/audit' || path.startsWith('work/audit/');
  const architectRoundPath = path === 'work/rounds' || path.startsWith('work/rounds/');
  const ownerPath = path === 'product' || path.startsWith('product/');
  const jointGlossaryPath = path === 'law/glossary' || path.startsWith('law/glossary/');
  const lawPath = path === 'law' || path.startsWith('law/');
  const architectPath =
    ROOT_ARCHITECT_PATHS.has(path) ||
    path === DECISION_REGISTER_PATH ||
    lawPath ||
    architectRoundPath ||
    path.startsWith('.changeset/') ||
    path === 'docs' ||
    path.startsWith('docs/');
  if (path === 'law/constitution.md') return { allowed: false, effect: 'fs:f5-config' };
  if (path === '.devai' || path.startsWith('.devai/')) {
    const effect: TranslationFilesystemEffect = path.startsWith('.devai/state/')
      ? 'fs:f5-state'
      : path.startsWith('.devai/inventory/')
        ? 'fs:inventory'
        : path.startsWith('.devai/worktrees/')
          ? 'fs:worktree-admin'
          : 'fs:f5-config';
    return { allowed: false, effect };
  }
  if (path === 'record' || path.startsWith('record/')) {
    return { allowed: false, effect: 'fs:proofs' };
  }
  if (path === 'scratch' || path.startsWith('scratch/')) {
    return { allowed: false, effect: 'fs:worktree-admin' };
  }
  if ((path === 'work' || path.startsWith('work/')) && !auditorObservation && !architectRoundPath) {
    return { allowed: false, effect: 'fs:architect-spec' };
  }
  if (auditorObservation) {
    // Article 7 permits observation only through the active round's authorized
    // runtime action. A legacy work/audit path supplies no such binding.
    return { allowed: false, effect: 'fs:auditor-observation' };
  }
  if (testPath) return { allowed: role === 'inspector', effect: 'fs:tests' };
  if (ownerPath) return { allowed: role === 'owner', effect: 'fs:owner-spec' };
  if (jointGlossaryPath) {
    return {
      allowed: role === 'owner' || role === 'architect',
      effect: role === 'owner' ? 'fs:owner-spec' : 'fs:architect-spec',
    };
  }
  if (architectPath) return { allowed: role === 'architect', effect: 'fs:architect-spec' };
  return { allowed: role === 'engineer', effect: 'fs:plant' };
}
