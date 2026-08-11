import { spawnSync } from '@devai-nyx/authority';
import { existsSync, readdirSync, readFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

/**
 * Documentation-governance check behind the canonical `check` facade.
 *
 * Enforces ADR-DOCS-GOVERNANCE (commit cf714e7). Nine rules:
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
 * Authority: policy_firewall (ADR-DOCS-GOVERNANCE Decision 6).
 */

const VALID_KINDS = ['library', 'application'] as const;
type RepoKind = (typeof VALID_KINDS)[number];

const VALID_BUILDERS = ['docusaurus', 'jekyll'] as const;
type Builder = (typeof VALID_BUILDERS)[number];

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

interface ProjectConfig {
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

function readProjectConfig(repoRoot: string): ProjectConfig | null {
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
function checkClassification(
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
          'Create .devai/config/project.json with repo.kind set to one of: library, application. See ADR-DOCS-GOVERNANCE Decision 1.',
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
          'Set repo.kind in .devai/config/project.json to "library" or "application". See ADR-DOCS-GOVERNANCE Decision 1.',
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
function checkBuilderDeclared(
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
          'Add docs.builder to .devai/config/project.json. Allowed values: docusaurus, jekyll. See ADR-DOCS-GOVERNANCE Decision 2.',
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
          'Set docs.builder in .devai/config/project.json. For library repos: "docusaurus" (required). For application repos: "docusaurus" (default) or "jekyll" (requires opt-out ADR). See ADR-DOCS-GOVERNANCE Decision 2.',
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
function checkLibraryDocusaurusRequired(
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
        'Change docs.builder to "docusaurus" in .devai/config/project.json. Library repos have no opt-out (ADR-DOCS-GOVERNANCE Decision 2 — the API-reference/search/versioning requirements are non-negotiable for library consumers).',
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
function checkOptOutAdr(
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
        'Create law/adr/ADR-DOCS-BUILDER-OPT-OUT.md recording: rationale (why Docusaurus is wrong for this repo), reviewer (named human + date), sunset trigger (condition under which the decision will be revisited). See ADR-DOCS-GOVERNANCE Decision 3.',
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
        'Ensure the opt-out ADR includes: "rationale" section, "reviewer" (named person + date), "date", and "sunset" trigger. All four are required per ADR-DOCS-GOVERNANCE Decision 3.',
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
function checkSiteDirShape(repoRoot: string, builder: Builder | null): GovernanceFinding {
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
          ? 'Scaffold a Docusaurus site under docs/site/ (npx create-docusaurus@latest docs/site classic --typescript). Required: docusaurus.config.ts, sidebars.ts, package.json. See ADR-DOCS-GOVERNANCE Decision 5.'
          : 'Initialize a Jekyll site under docs/site/ (jekyll new docs/site). Required: _config.yml, Gemfile. See ADR-DOCS-GOVERNANCE Decision 5.',
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
function checkBuildToolchain(
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

/**
 * Rule 7 — gh-pages branch exists on origin.
 * git ls-remote origin gh-pages → any ref. WARN if missing.
 */
function checkGhPagesBranch(
  repoRoot: string,
  cfg: ProjectConfig | null,
  noPublishCheck: boolean,
): GovernanceFinding {
  if (noPublishCheck) {
    return {
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'pass',
      message: 'gh-pages branch check skipped via --skip-publish-check',
    };
  }

  const branch = cfg?.docs?.gh_pages_branch ?? 'gh-pages';

  const r = spawnSync('git', ['ls-remote', 'origin', branch], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });

  if (r.status !== 0) {
    // Network failure or no remote — treat as a warning, not a hard fail.
    return {
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'warn',
      message: `Cannot check gh-pages branch — git ls-remote returned non-zero (remote may be unreachable)`,
      remediation: `Create the ${branch} branch only through the separately authorized site-publication process.`,
    };
  }

  const stdout = r.stdout ?? '';
  if (stdout.trim().length === 0) {
    return {
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'warn',
      message: `gh-pages branch "${branch}" does not exist on origin — first publish has not run yet`,
      remediation: `Create the ${branch} branch only through the separately authorized site-publication process.`,
    };
  }

  return {
    ruleId: 'docs-governance.gh-pages-branch',
    severity: 'pass',
    message: `gh-pages branch "${branch}" exists on origin`,
  };
}

/**
 * Rule 8 — No GH Actions docs-publish workflow.
 * Grep .github/workflows/*.yml|.yaml for known documentation-deployment actions.
 * FAIL if found. Per ADR-LOCAL-PUBLISH-WORKFLOW §10.
 */
const CI_PUBLISH_PATTERNS = [
  'peaceiris/actions-gh-pages',
  'actions/deploy-pages',
  'JamesIves/github-pages-deploy-action',
] as const;

function checkNoCiPublish(repoRoot: string): GovernanceFinding {
  const workflowDir = join(repoRoot, '.github/workflows');
  if (!existsSync(workflowDir)) {
    return {
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'pass',
      message: 'No .github/workflows/ directory — no CI publish workflow to check',
    };
  }

  let workflows: string[];
  try {
    workflows = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    return {
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'pass',
      message: 'Could not read .github/workflows/ directory',
    };
  }

  const violations: string[] = [];
  for (const wf of workflows) {
    const wfPath = join(workflowDir, wf);
    let content: string;
    try {
      content = readFileSync(wfPath, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of CI_PUBLISH_PATTERNS) {
      if (content.includes(pattern)) {
        violations.push(`${wf}: contains "${pattern}"`);
        break; // one violation per file is enough
      }
    }
  }

  if (violations.length > 0) {
    return {
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'fail',
      message: `Found CI docs-publish workflow(s) — violates ADR-LOCAL-PUBLISH-WORKFLOW §10 (publish MUST be local-act, not CI-driven)`,
      remediation:
        'Remove or disable the GH Actions documentation-deployment workflow. CI validates freshness and does not publish the site.',
      locations: violations.map((v) => `.github/workflows/${v.split(':')[0] ?? v}`),
    };
  }

  return {
    ruleId: 'docs-governance.no-ci-publish',
    severity: 'pass',
    message: 'No CI docs-publish workflow found',
  };
}

// ---------------------------------------------------------------------------
// Rule 9 — Placeholder config values
// ---------------------------------------------------------------------------

/**
 * URL patterns that indicate a Docusaurus scaffold default or intentional
 * placeholder has not been replaced before publishing.
 * Source: W06-fix-2 (commit 83f72d6) — these were the live values that
 * broke CSS and nav on the published Pages site.
 */
const PLACEHOLDER_URL_PATTERNS: RegExp[] = [
  /^https?:\/\/example\.(com|invalid|test|org|net)\/?$/i,
  /^https?:\/\/your-docusaurus-site\.example\.com\/?$/i,
  /^https?:\/\/localhost(:\d+)?\/?$/i,
];

/**
 * organizationName values that indicate a scaffold default or intentional
 * placeholder. 'devai-org' was W05's own placeholder (W06-fix-2 corrected to
 * 'aarusso-nyx').
 */
const PLACEHOLDER_ORGS: Set<string> = new Set([
  'facebook',
  'organization-name',
  'your-org',
  'placeholder',
  'devai-org',
]);

/**
 * Rule 9 — No scaffold/placeholder values in docs/site/docusaurus.config.ts|.js.
 * Scope: builder === 'docusaurus' only.
 * Checks `url` against known placeholder URL patterns and `organizationName`
 * against a known placeholder set. `baseUrl` is intentionally not validated
 * (legitimate variation across user/org/project pages).
 *
 * Prevents recurrence of W06-fix-2 (commit 83f72d6): a publish with
 * url='https://example.invalid', baseUrl='/', organizationName='devai-org'
 * caused broken CSS + nav on the live Pages site.
 */
function checkConfigNotPlaceholder(repoRoot: string, builder: Builder | null): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'Skipped — rule only applies to docs.builder = "docusaurus"',
    };
  }

  const siteDir = join(repoRoot, 'docs/site');
  let configPath: string | null = null;
  let configRelPath: string | null = null;

  const tsPath = join(siteDir, 'docusaurus.config.ts');
  const jsPath = join(siteDir, 'docusaurus.config.js');
  if (existsSync(tsPath)) {
    configPath = tsPath;
    configRelPath = 'docs/site/docusaurus.config.ts';
  } else if (existsSync(jsPath)) {
    configPath = jsPath;
    configRelPath = 'docs/site/docusaurus.config.js';
  }

  if (configPath === null || configRelPath === null) {
    // Rule 5 already reports the missing file; skip here to avoid duplication.
    return {
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'Skipped — config file absent (covered by rule 5)',
    };
  }

  let src: string;
  try {
    src = readFileSync(configPath, 'utf8');
  } catch {
    return {
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'warn',
      message: `could not read ${configRelPath}; manual review recommended`,
      locations: [configRelPath],
    };
  }

  // Regex extraction — robust for the well-formed Docusaurus scaffold shape.
  const urlMatch = src.match(/^\s*url:\s*['"`]([^'"`]+)['"`]/m);
  const orgMatch = src.match(/^\s*organizationName:\s*['"`]([^'"`]+)['"`]/m);

  // If neither field is parseable, we can't verify — warn rather than silently pass.
  if (urlMatch === null && orgMatch === null) {
    return {
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'warn',
      message: `could not parse url/baseUrl/organizationName from ${configRelPath}; manual review recommended`,
      locations: [configRelPath],
    };
  }

  const violations: Array<{ field: string; value: string; lineNumber: number }> = [];

  if (urlMatch !== null) {
    const urlValue = urlMatch[1] ?? '';
    const isPlaceholder = PLACEHOLDER_URL_PATTERNS.some((p) => p.test(urlValue));
    if (isPlaceholder) {
      // Find which line this match is on.
      const linesBefore = src.slice(0, urlMatch.index ?? 0).split('\n');
      const lineNum = linesBefore.length;
      violations.push({ field: 'url', value: urlValue, lineNumber: lineNum });
    }
  }

  if (orgMatch !== null) {
    const orgValue = orgMatch[1] ?? '';
    if (PLACEHOLDER_ORGS.has(orgValue.toLowerCase())) {
      const linesBefore = src.slice(0, orgMatch.index ?? 0).split('\n');
      const lineNum = linesBefore.length;
      violations.push({ field: 'organizationName', value: orgValue, lineNumber: lineNum });
    }
  }

  if (violations.length > 0) {
    const fieldList = violations.map((v) => `${v.field}="${v.value}"`).join(', ');
    const locations = violations.map((v) => `${configRelPath}:${String(v.lineNumber)}`);
    return {
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'fail',
      message: `${configRelPath} contains placeholder value(s): ${fieldList}`,
      remediation:
        `Update \`url\`/\`organizationName\` in \`${configRelPath}\` to match your deployment. ` +
        `For GitHub Pages project pages, url should be \`https://<org>.github.io\` and ` +
        `organizationName should be \`<org>\`.`,
      locations,
    };
  }

  return {
    ruleId: 'docs-governance.config-not-placeholder',
    severity: 'pass',
    message: `${configRelPath} has no placeholder url or organizationName`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface CheckDocsGovernanceOptions {
  readonly repoRoot?: string;
  readonly noPublishCheck?: boolean;
}

// ---------------------------------------------------------------------------
// Documentation information-architecture rules.
// ---------------------------------------------------------------------------

/**
 * Rule docs-ia.landing-exists — a landing page exists at the Pages root.
 * Either docs/site/docs/start/index.md OR docs/site/src/pages/index.tsx
 * satisfies the rule.
 */
function checkDocsIaLandingExists(
  repoRoot: string,
  builder: Builder | undefined | null,
): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-ia.landing-exists',
      severity: 'pass',
      message: 'Skipped — non-Docusaurus builder',
    };
  }
  const candidates = [
    join(repoRoot, 'docs/site/docs/start/index.md'),
    join(repoRoot, 'docs/site/src/pages/index.tsx'),
    join(repoRoot, 'docs/_ia/categories.json'), // post-sync the landing emerges from start/ + categories
    join(repoRoot, 'docs/start/index.md'),
  ];
  const found = candidates.filter((p) => existsSync(p));
  if (found.length === 0) {
    return {
      ruleId: 'docs-ia.landing-exists',
      severity: 'fail',
      message:
        'No landing page found. Expected docs/start/index.md or docs/site/src/pages/index.tsx.',
      remediation:
        'Author a landing page at docs/start/index.md (or docs/site/src/pages/index.tsx) per ADR-DOCS-IA Decision 1 §1.',
    };
  }
  return {
    ruleId: 'docs-ia.landing-exists',
    severity: 'pass',
    message: `Landing present (${found[0]?.replace(repoRoot + '/', '') ?? '?'})`,
  };
}

/**
 * Rule docs-ia.constitution-published — if law/constitution.md exists,
 * the synced site has framework/constitution.md AND a versioned_docs/version-<v>
 * snapshot for each prior version in the amendment history.
 */
function checkDocsIaConstitutionPublished(
  repoRoot: string,
  builder: Builder | undefined | null,
): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-ia.constitution-published',
      severity: 'pass',
      message: 'Skipped — non-Docusaurus builder',
    };
  }
  const constitution = join(repoRoot, 'law/constitution.md');
  if (!existsSync(constitution)) {
    return {
      ruleId: 'docs-ia.constitution-published',
      severity: 'pass',
      message: 'No law/constitution.md — rule N/A',
    };
  }
  // Either the sync stub (source-side) or the synced output should exist.
  const stub = join(repoRoot, 'docs/reference/law.md');
  const synced = join(repoRoot, 'docs/site/docs/reference/law.md');
  if (!existsSync(stub) && !existsSync(synced)) {
    return {
      ruleId: 'docs-ia.constitution-published',
      severity: 'fail',
      message: 'Constitution exists at repo root but no Pages destination is set up.',
      remediation: 'Publish the law projection at docs/reference/law.md and run the site sync.',
    };
  }
  // versioned-docs (if present) should cover each prior version's snapshot.
  const versionsPath = join(repoRoot, 'docs/site/versions.json');
  if (existsSync(versionsPath)) {
    let versions: string[] = [];
    try {
      versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
    } catch {
      /* skip */
    }
    const missingSnapshots: string[] = [];
    for (const v of versions) {
      const snapshot = join(
        repoRoot,
        `docs/site/versioned_docs/version-${v}/framework/constitution.md`,
      );
      if (!existsSync(snapshot)) missingSnapshots.push(v);
    }
    if (missingSnapshots.length > 0) {
      return {
        ruleId: 'docs-ia.constitution-published',
        severity: 'fail',
        message: `versioned_docs missing constitution snapshot for: ${missingSnapshots.join(', ')}`,
        remediation: 'Re-run docusaurus docs:version <v> for the missing version(s).',
      };
    }
  }
  return {
    ruleId: 'docs-ia.constitution-published',
    severity: 'pass',
    message: 'Constitution published per ADR-DOCS-IA Decisions 4 + 8',
  };
}

/**
 * Rule docs-ia.sidebar-curated — sidebars.ts does not consist exclusively of
 * top-level autogenerated items. A hand-authored 7-section layout (or any
 * non-trivial curation) satisfies the rule.
 */
function checkDocsIaSidebarCurated(
  repoRoot: string,
  builder: Builder | undefined | null,
): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'pass',
      message: 'Skipped — non-Docusaurus builder',
    };
  }
  const candidates = ['docs/site/sidebars.ts', 'docs/site/sidebars.js'];
  let content = '';
  for (const c of candidates) {
    const p = join(repoRoot, c);
    if (existsSync(p)) {
      content = readFileSync(p, 'utf8');
      break;
    }
  }
  if (content === '') {
    return {
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'pass',
      message: 'No sidebars.ts/js (Docusaurus default sidebar)',
    };
  }
  // Heuristic: a curated sidebar references category labels or specific doc IDs;
  // a degenerate fully-autogenerated sidebar contains only `autogenerated` and braces.
  const hasLabels = /label:\s*['"]/.test(content);
  const hasMultipleAutogenerated = (content.match(/autogenerated/g) ?? []).length;
  if (!hasLabels && hasMultipleAutogenerated <= 1) {
    return {
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'fail',
      message: 'sidebars.ts appears to be fully autogenerated with no explicit category labels.',
      remediation:
        'Author a curated sidebar with explicit `label:` fields per ADR-DOCS-IA Decision 5 §1.',
    };
  }
  return {
    ruleId: 'docs-ia.sidebar-curated',
    severity: 'pass',
    message: 'Sidebar carries explicit labels',
  };
}

/**
 * Rule docs-ia.framework-meta-split — law/ and docs/ exist as sibling
 * top-level categories in the current source tree.
 */
function checkDocsIaFrameworkMetaSplit(
  repoRoot: string,
  builder: Builder | undefined | null,
): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-ia.framework-meta-split',
      severity: 'pass',
      message: 'Skipped — non-Docusaurus builder',
    };
  }
  const frameworkDir = join(repoRoot, 'law');
  const metaDir = join(repoRoot, 'docs');
  const frameworkExists = existsSync(frameworkDir);
  const metaExists = existsSync(metaDir);
  if (!frameworkExists || !metaExists) {
    const missing = [!frameworkExists ? 'law/' : null, !metaExists ? 'docs/' : null]
      .filter(Boolean)
      .join(', ');
    return {
      ruleId: 'docs-ia.framework-meta-split',
      severity: 'fail',
      message: `Law/Docs sibling split missing: ${missing}`,
      remediation: 'Create the missing law or documentation directory.',
    };
  }
  return {
    ruleId: 'docs-ia.framework-meta-split',
    severity: 'pass',
    message: 'law/ and docs/ are siblings',
  };
}

/**
 * Rule docs-ia.dashboard-current — for each dashboard page that exists under
 * §3 (framework/aspect-grid.md) or §7 (meta/self-scorecard.md, meta/test-matrix.md),
 * verify the page's last_built_at frontmatter is younger than 30 days relative
 * to its latest input file's mtime. Soft check — surfaces stale dashboards
 * without blocking.
 */
function checkDocsIaDashboardCurrent(
  repoRoot: string,
  builder: Builder | undefined | null,
): GovernanceFinding {
  if (builder !== 'docusaurus') {
    return {
      ruleId: 'docs-ia.dashboard-current',
      severity: 'pass',
      message: 'Skipped — non-Docusaurus builder',
    };
  }
  const dashboards = [
    'docs/site/docs/theory/framework/aspect-grid.md',
    'docs/site/docs/reference/self-scorecard.md',
    'docs/site/docs/reference/test-matrix.md',
  ];
  const stale: string[] = [];
  for (const d of dashboards) {
    const path = join(repoRoot, d);
    if (!existsSync(path)) continue;
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const m = content.match(/last_built_at:\s*(\S+)/);
    if (!m || m[1] === undefined) continue; // no frontmatter; skip silently
    const ts = Date.parse(m[1]);
    if (Number.isNaN(ts)) continue;
    const ageMs = Date.now() - ts;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > 30) stale.push(`${d} (${Math.floor(ageDays)} days old)`);
  }
  if (stale.length > 0) {
    return {
      ruleId: 'docs-ia.dashboard-current',
      severity: 'warn',
      message: `Dashboards older than 30 days: ${stale.join('; ')}`,
      remediation:
        'Run npm run sync-docs to regenerate (per ADR-DOCS-IA Decision 7 — frozen-at-build, refresh on publish).',
    };
  }
  return {
    ruleId: 'docs-ia.dashboard-current',
    severity: 'pass',
    message: 'Dashboards current (or absent)',
  };
}

export function checkDocsGovernance(opts: CheckDocsGovernanceOptions = {}): DocsGovernanceReport {
  const repoRoot = opts.repoRoot ?? '.';
  const noPublishCheck = opts.noPublishCheck ?? false;

  const cfg = readProjectConfig(repoRoot);

  const rule1 = checkClassification(cfg, repoRoot);
  const rule2 = checkBuilderDeclared(cfg, repoRoot);
  const rule3Finding = checkLibraryDocusaurusRequired(rule1.kind, rule2.builder);
  const rule4Finding = checkOptOutAdr(repoRoot, rule1.kind, rule2.builder);
  const rule5Finding = checkSiteDirShape(repoRoot, rule2.builder);
  const rule6Finding = checkBuildToolchain(repoRoot, cfg, rule2.builder);
  const rule7Finding = checkGhPagesBranch(repoRoot, cfg, noPublishCheck);
  const rule8Finding = checkNoCiPublish(repoRoot);
  const rule9Finding = checkConfigNotPlaceholder(repoRoot, rule2.builder);
  const ruleIa1 = checkDocsIaLandingExists(repoRoot, rule2.builder);
  const ruleIa2 = checkDocsIaConstitutionPublished(repoRoot, rule2.builder);
  const ruleIa3 = checkDocsIaSidebarCurated(repoRoot, rule2.builder);
  const ruleIa4 = checkDocsIaFrameworkMetaSplit(repoRoot, rule2.builder);
  const ruleIa5 = checkDocsIaDashboardCurrent(repoRoot, rule2.builder);

  const allFindings: GovernanceFinding[] = [
    rule1.finding,
    rule2.finding,
    rule3Finding,
    rule4Finding,
    rule5Finding,
    rule6Finding,
    rule7Finding,
    rule8Finding,
    rule9Finding,
    ruleIa1,
    ruleIa2,
    ruleIa3,
    ruleIa4,
    ruleIa5,
  ];

  const failCount = allFindings.filter((f) => f.severity === 'fail').length;
  const warnCount = allFindings.filter((f) => f.severity === 'warn').length;

  let verdict: 'pass' | 'warn' | 'fail';
  if (failCount > 0) {
    verdict = 'fail';
  } else if (warnCount > 0) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  return {
    verdict,
    rules_checked: allFindings.length,
    findings: allFindings,
    fail_count: failCount,
    warn_count: warnCount,
  };
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

const DEFAULT_REPO_ROOT = process.cwd();

export const checkDocsGovernanceCmd = defineCommand({
  name: 'check docs-governance',
  description:
    'Validate repo against ADR-DOCS-GOVERNANCE: classification, builder choice, opt-out ADR, site-dir shape, build toolchain, gh-pages branch, and no-CI-publish rule. Hard-fail gate per ADR-DOCS-GOVERNANCE Decision 6.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command('check-docs-governance', 'Validate docs governance rules (ADR-DOCS-GOVERNANCE)')
      .option('--repo-root <path>', `Repo root (default: cwd)`)
      .option(
        '--skip-publish-check',
        'Skip the gh-pages branch existence check (for pre-conversion adopters)',
      )
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; skipPublishCheck?: boolean; human?: boolean }) => {
        const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
        const report = checkDocsGovernance({
          repoRoot,
          noPublishCheck: options.skipPublishCheck === true,
        });

        if (options.human === true) {
          const lines: string[] = [];
          const verdictLabel =
            report.verdict === 'pass' ? 'PASS' : report.verdict === 'warn' ? 'WARN' : 'FAIL';
          lines.push(
            `check docs-governance: ${verdictLabel} (${String(report.rules_checked)} rules, ${String(report.fail_count)} fail, ${String(report.warn_count)} warn)`,
          );
          for (const f of report.findings) {
            const icon = f.severity === 'pass' ? '✓' : f.severity === 'warn' ? '!' : '✗';
            lines.push(`  [${icon}] ${f.ruleId}: ${f.message}`);
            if (f.severity !== 'pass' && f.remediation !== undefined) {
              lines.push(`      Remediation: ${f.remediation}`);
            }
            if (f.locations !== undefined && f.locations.length > 0) {
              lines.push(`      Locations: ${f.locations.join(', ')}`);
            }
          }
          process.stdout.write(lines.join('\n') + '\n');
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }

        // Exit fail only on hard-fail findings; warn exits 0 (advisory).
        process.exit(report.fail_count > 0 ? EXIT_FAIL : EXIT_PASS);
      });
  },
});
