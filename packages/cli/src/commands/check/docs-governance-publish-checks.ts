import { spawnSync } from '@devai-nyx/authority';
import { existsSync, readdirSync, readFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import type { ProjectConfig, GovernanceFinding, Builder } from './docs-governance-config-checks.js';

/**
 * Rule 7 — gh-pages branch exists on origin.
 * git ls-remote origin gh-pages → any ref. WARN if missing.
 */
export function checkGhPagesBranch(
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
 * FAIL if found. See docs/adopters/docs-layout.md#publication-boundary.
 */
const CI_PUBLISH_PATTERNS = [
  'peaceiris/actions-gh-pages',
  'actions/deploy-pages',
  'JamesIves/github-pages-deploy-action',
] as const;

export function checkNoCiPublish(repoRoot: string): GovernanceFinding {
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
      message: `Found CI docs-publish workflow(s) — documentation publishing must be an explicitly authorized local effect; see docs/adopters/docs-layout.md#publication-boundary`,
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
export function checkConfigNotPlaceholder(
  repoRoot: string,
  builder: Builder | null,
): GovernanceFinding {
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
