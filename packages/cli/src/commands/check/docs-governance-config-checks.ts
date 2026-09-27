import { spawnSync } from '@devai-nyx/authority';
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';

/**
 * Documentation-governance check behind the canonical `check` facade.
 *
 * Enforces docs/adopters/docs-layout.md. Nine rules:
 *
 *   1. docs-governance.classification — repo.kind ∈ {library, application} (FAIL)
 *   2. docs-governance.builder-declared — docs.builder ∈ {docusaurus, jekyll} (FAIL)
 *   3. docs-governance.library-docusaurus-required — library MUST be docusaurus (FAIL)
 *   4. docs-governance.opt-out-adr-required — app+jekyll requires opt-out ADR (FAIL)
 *   5. docs-governance.site-dir-shape — expected files under docs/site/ (FAIL)
 *   6. docs-governance.build-toolchain — build command dry-validates (WARN)
 *   7. docs-governance.gh-pages-branch — gh-pages exists on origin (WARN)
 *   8. docs-governance.no-ci-publish — no GH Actions docs-publish workflow (FAIL)
 *   9. docs-governance.config-not-placeholder — no scaffold/placeholder values in
 *      docusaurus.config.ts (url, organizationName) (FAIL)
 *
 * Authority: policy_firewall; see docs/adopters/docs-layout.md.
 */

const VALID_KINDS = ['library', 'application'] as const;
type RepoKind = (typeof VALID_KINDS)[number];

const VALID_BUILDERS = ['docusaurus', 'jekyll'] as const;
export type Builder = (typeof VALID_BUILDERS)[number];

/** The required sections in ADR-DOCS-BUILDER-OPT-OUT.md. */
const OPT_OUT_ADR_SECTIONS = ['rationale', 'reviewer', 'date', 'sunset'] as const;

export interface GovernanceFinding {
  readonly ruleId: string;
  readonly severity: 'fail' | 'warn' | 'pass';
  readonly message: string;
  readonly remediation?: string;
  readonly locations?: string[];
}

export interface DocsGovernanceReport {
  /** Aggregate verdict: pass / warn / fail. */
  readonly verdict: 'pass' | 'warn' | 'fail';
  readonly rules_checked: number;
  readonly findings: readonly GovernanceFinding[];
  /** Quick counts. */
  readonly fail_count: number;
  readonly warn_count: number;
}

export interface ProjectConfig {
  readonly repo?: { readonly kind?: string };
  readonly docs?: {
    readonly builder?: string;
    readonly build_command?: string;
    readonly publish_target?: string;
    readonly gh_pages_branch?: string;
  };
}

const BUILDER_DEFAULTS: Record<Builder, { readonly build_command: string }> = {
  docusaurus: { build_command: 'npx docusaurus' },
  jekyll: { build_command: 'bundle exec jekyll' },
};

export function readProjectConfig(repoRoot: string): ProjectConfig | null {
  const cfgPath = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(cfgPath)) return null;
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8')) as ProjectConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * Rule 1 — Classification present.
 * repo.kind ∈ {library, application}. FAIL otherwise.
 */
export function checkClassification(
  cfg: ProjectConfig | null,
  _repoRoot: string,
): { finding: GovernanceFinding; kind: RepoKind | null } {
  if (cfg === null) {
    return {
      finding: {
        ruleId: 'docs-governance.classification',
        severity: 'fail',
        message: '.devai/config/project.json is missing or unreadable',
        remediation:
          'Create .devai/config/project.json with repo.kind set to one of: library, application. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
        locations: ['.devai/config/project.json'],
      },
      kind: null,
    };
  }
  const kindRaw = cfg.repo?.kind;
  if (kindRaw === undefined || !VALID_KINDS.includes(kindRaw as RepoKind)) {
    return {
      finding: {
        ruleId: 'docs-governance.classification',
        severity: 'fail',
        message: `repo.kind must be one of [${VALID_KINDS.join(', ')}]; got ${String(kindRaw ?? 'undefined')}`,
        remediation:
          'Set repo.kind in .devai/config/project.json to "library" or "application". See docs/adopters/docs-layout.md#repository-classification-and-builder.',
        locations: ['.devai/config/project.json#/repo/kind'],
      },
      kind: null,
    };
  }
  return {
    finding: {
      ruleId: 'docs-governance.classification',
      severity: 'pass',
      message: `repo.kind = "${kindRaw}" — valid`,
    },
    kind: kindRaw as RepoKind,
  };
}

/**
 * Rule 2 — Builder declared.
 * docs.builder ∈ {docusaurus, jekyll}. FAIL otherwise.
 */
export function checkBuilderDeclared(
  cfg: ProjectConfig | null,
  _repoRoot: string,
): { finding: GovernanceFinding; builder: Builder | null } {
  if (cfg === null) {
    // Config missing is already reported by rule 1; issue a pass so we don't
    // double-count a failure that's already attributed.
    return {
      finding: {
        ruleId: 'docs-governance.builder-declared',
        severity: 'fail',
        message: 'Cannot check docs.builder — .devai/config/project.json is missing',
        remediation:
          'Add docs.builder to .devai/config/project.json. Allowed values: docusaurus, jekyll. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
        locations: ['.devai/config/project.json'],
      },
      builder: null,
    };
  }
  const builderRaw = cfg.docs?.builder;
  if (builderRaw === undefined || !VALID_BUILDERS.includes(builderRaw as Builder)) {
    return {
      finding: {
        ruleId: 'docs-governance.builder-declared',
        severity: 'fail',
        message: `docs.builder must be one of [${VALID_BUILDERS.join(', ')}]; got ${String(builderRaw ?? 'undefined')}`,
        remediation:
          'Set docs.builder in .devai/config/project.json. For library repos: "docusaurus" (required). For application repos: "docusaurus" (default) or "jekyll" (requires opt-out ADR). See docs/adopters/docs-layout.md#repository-classification-and-builder.',
        locations: ['.devai/config/project.json#/docs/builder'],
      },
      builder: null,
    };
  }
  return {
    finding: {
      ruleId: 'docs-governance.builder-declared',
      severity: 'pass',
      message: `docs.builder = "${builderRaw}" — valid`,
    },
    builder: builderRaw as Builder,
  };
}

/**
 * Rule 3 — Library → Docusaurus required.
 * If kind === 'library' then builder MUST be 'docusaurus'. FAIL otherwise. No opt-out.
 */
export function checkLibraryDocusaurusRequired(
  kind: RepoKind | null,
  builder: Builder | null,
): GovernanceFinding {
  // If kind or builder is null we can't evaluate this rule; skip.
  if (kind === null || builder === null) {
    return {
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'pass',
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    };
  }
  if (kind === 'library' && builder !== 'docusaurus') {
    return {
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'fail',
      message: `Library repos MUST use Docusaurus; got docs.builder = "${builder}"`,
      remediation:
        'Change docs.builder to "docusaurus" in .devai/config/project.json. Libraries have no opt-out because downstream consumers require searchable, versioned API documentation. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json#/docs/builder'],
    };
  }
  return {
    ruleId: 'docs-governance.library-docusaurus-required',
    severity: 'pass',
    message:
      kind === 'library'
        ? 'Library correctly uses docusaurus'
        : 'Not a library repo — rule does not apply',
  };
}

/**
 * Rule 4 — App opt-out has ADR.
 * If kind === 'application' AND builder === 'jekyll', then
 * law/adr/ADR-DOCS-BUILDER-OPT-OUT.md must exist with required sections.
 */
export function checkOptOutAdr(
  repoRoot: string,
  kind: RepoKind | null,
  builder: Builder | null,
): GovernanceFinding {
  if (kind === null || builder === null) {
    return {
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    };
  }
  if (kind !== 'application' || builder !== 'jekyll') {
    return {
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Not applicable — only required for application + jekyll combination',
    };
  }
  const adrPath = join(repoRoot, 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md');
  if (!existsSync(adrPath)) {
    return {
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message: 'Application + jekyll requires law/adr/ADR-DOCS-BUILDER-OPT-OUT.md — file not found',
      remediation:
        'Create law/adr/ADR-DOCS-BUILDER-OPT-OUT.md recording: rationale (why Docusaurus is wrong for this repo), reviewer (named human + date), and sunset trigger. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    };
  }
  // Verify required sections exist in the ADR.
  let content: string;
  try {
    content = readFileSync(adrPath, 'utf8').toLowerCase();
  } catch {
    return {
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message: 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md is unreadable',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    };
  }
  const missingSections: string[] = [];
  for (const section of OPT_OUT_ADR_SECTIONS) {
    if (!content.includes(section)) {
      missingSections.push(section);
    }
  }
  if (missingSections.length > 0) {
    return {
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message: `law/adr/ADR-DOCS-BUILDER-OPT-OUT.md is missing required section(s): ${missingSections.join(', ')}`,
      remediation:
        'Ensure the opt-out ADR includes: "rationale", "reviewer", "date", and "sunset" sections. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    };
  }
  return {
    ruleId: 'docs-governance.opt-out-adr-required',
    severity: 'pass',
    message: 'Opt-out ADR present with required sections',
    locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
  };
}

/**
 * Rule 5 — Site directory shape.
 * Docusaurus: docusaurus.config.ts|.js + sidebars.ts|.js + package.json
 * Jekyll: _config.yml + Gemfile
 */
export function checkSiteDirShape(repoRoot: string, builder: Builder | null): GovernanceFinding {
  if (builder === null) {
    return {
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'pass',
      message: 'Skipped — builder is unresolvable (see prior findings)',
    };
  }
  const siteDir = join(repoRoot, 'docs/site');
  const missing: string[] = [];

  if (builder === 'docusaurus') {
    const configExists =
      existsSync(join(siteDir, 'docusaurus.config.ts')) ||
      existsSync(join(siteDir, 'docusaurus.config.js'));
    if (!configExists) missing.push('docs/site/docusaurus.config.ts (or .js)');

    const sidebarsExists =
      existsSync(join(siteDir, 'sidebars.ts')) || existsSync(join(siteDir, 'sidebars.js'));
    if (!sidebarsExists) missing.push('docs/site/sidebars.ts (or .js)');

    if (!existsSync(join(siteDir, 'package.json'))) {
      missing.push('docs/site/package.json');
    }
  } else {
    // jekyll
    if (!existsSync(join(siteDir, '_config.yml'))) {
      missing.push('docs/site/_config.yml');
    }
    if (!existsSync(join(siteDir, 'Gemfile'))) {
      missing.push('docs/site/Gemfile');
    }
  }

  if (missing.length > 0) {
    return {
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'fail',
      message: `docs/site/ is missing expected ${builder} file(s): ${missing.join(', ')}`,
      remediation:
        builder === 'docusaurus'
          ? 'Scaffold a Docusaurus site under docs/site/ (npx create-docusaurus@latest docs/site classic --typescript). Required: docusaurus.config.ts, sidebars.ts, package.json. See docs/adopters/docs-layout.md#repository-classification-and-builder.'
          : 'Initialize a Jekyll site under docs/site/ (jekyll new docs/site). Required: _config.yml, Gemfile. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: missing,
    };
  }

  return {
    ruleId: 'docs-governance.site-dir-shape',
    severity: 'pass',
    message: `docs/site/ has expected ${builder} structure`,
  };
}

/**
 * Rule 6 — Build command resolvable.
 * Runs the configured build_command with --version or --help. WARN on failure.
 */
export function checkBuildToolchain(
  repoRoot: string,
  cfg: ProjectConfig | null,
  builder: Builder | null,
): GovernanceFinding {
  if (builder === null) {
    return {
      ruleId: 'docs-governance.build-toolchain',
      severity: 'pass',
      message: 'Skipped — builder is unresolvable (see prior findings)',
    };
  }

  const configuredCmd = cfg?.docs?.build_command;
  // Derive the first binary from the configured or default command.
  const defaultCmd = BUILDER_DEFAULTS[builder].build_command;
  const cmdLine = configuredCmd ?? defaultCmd;
  const parts = cmdLine.split(/\s+/);
  const binary = parts[0] ?? '';

  if (binary.length === 0) {
    return {
      ruleId: 'docs-governance.build-toolchain',
      severity: 'warn',
      message: 'build_command is empty or unresolvable',
      remediation:
        'Set docs.build_command in .devai/config/project.json to the command that builds the docs site.',
    };
  }

  // Attempt: binary --version, then binary --help. Either succeeding is a pass.
  for (const probe of ['--version', '--help'] as const) {
    const r = spawnSync(binary, [probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      shell: false,
    });
    if (r.status === 0 || (r.status !== null && r.status !== 127 && r.status !== 1)) {
      // Exit 0 or non-"command not found" exit on --version is good enough.
      if (r.status === 0) {
        return {
          ruleId: 'docs-governance.build-toolchain',
          severity: 'pass',
          message: `Build toolchain "${binary}" is on PATH and responds to ${probe}`,
        };
      }
    }
  }

  // If npx-based, try resolving via npx to cover "not globally installed" case.
  const isNpx = binary === 'npx' || parts.some((p) => p.includes('docusaurus'));
  if (isNpx) {
    return {
      ruleId: 'docs-governance.build-toolchain',
      severity: 'pass',
      message: `Build toolchain uses npx — resolved by npx at build time (not validated pre-install)`,
    };
  }

  return {
    ruleId: 'docs-governance.build-toolchain',
    severity: 'warn',
    message: `Build toolchain "${binary}" may not be on PATH or does not respond to --version/--help`,
    remediation: `Install the build toolchain for builder="${builder}". For Docusaurus: ensure Node.js is installed and run "npm install" under docs/site/. For Jekyll: install Ruby and run "bundle install" in docs/site/.`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface CheckDocsGovernanceOptions {
  readonly repoRoot?: string;
  readonly noPublishCheck?: boolean;
}
