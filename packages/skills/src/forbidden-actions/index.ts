import { execFileSync } from '@devai-nyx/authority';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Forbidden-action runtime gate. The canonical registry lives at
 * law/policy/forbidden-actions.json;
 * adopters receive its materialized copy under .devai/config/. The gate scans recent git
 * activity for matches against `detect_patterns` and reports findings.
 *
 * The scanner is intentionally CONSERVATIVE: it reports likely
 * violations but cannot prove they were unauthorised — the human is
 * the authoriser per LAW-12.FORBID.1, and this scanner can't see
 * authorisation grants. CI consumes the findings as warnings unless
 * configured otherwise.
 */

export interface ForbiddenActionEntry {
  readonly id: string;
  readonly action: string;
  readonly rationale: string;
  readonly severity: 'critical' | 'high' | 'medium';
  readonly detect_patterns?: readonly string[];
  readonly allowed_change_line_patterns?: readonly string[];
  readonly safer_alternative?: string;
}

export interface ForbiddenActionWaiver {
  readonly id: string;
  readonly reason: string;
}

/**
 * D-123 (item 6): the single source of truth for the canonical
 * 16-entry registry. `buildBootstrapPlan` (packages/skills/src/bootstrap/index.ts)
 * seeds a fresh repo's `forbidden-actions.json` from this exact list;
 * `checkForbiddenRegistryCoverage` below compares a repo's actual
 * registry against it. Previously these lived as two independently
 * hand-maintained copies (a bootstrap-plan JSON literal and this
 * module's own knowledge of "the canonical 16") — a single constant
 * makes drift between "what we seed" and "what we check" structurally
 * impossible.
 */
export const CANONICAL_FORBIDDEN_ACTIONS: readonly ForbiddenActionEntry[] = [
  {
    id: 'FORBID-FORCE-PUSH',
    action: 'Force-push to any branch',
    rationale: 'Overwrites history',
    severity: 'critical',
    detect_patterns: ['\\bgit\\s+push\\s+--force\\b', '\\bgit\\s+push\\s+\\+'],
    safer_alternative: 'Open a new PR; merge via the platform',
  },
  {
    id: 'FORBID-PUSH-MAIN',
    action: 'Push to `main` directly',
    rationale: 'Bypasses review',
    severity: 'critical',
    detect_patterns: ['\\bgit\\s+push\\s+.*\\bmain\\b'],
    safer_alternative: 'Push to a feature branch + PR',
  },
  {
    id: 'FORBID-RESET-HARD',
    action: '`git reset --hard` on tracked changes',
    rationale: 'Data loss',
    severity: 'critical',
    detect_patterns: ['\\bgit\\s+reset\\s+--hard\\b'],
    safer_alternative: 'git stash or branch the work first',
  },
  {
    id: 'FORBID-REBASE-I',
    action: '`git rebase --interactive`',
    rationale: 'Rewrites history',
    severity: 'high',
    detect_patterns: ['\\bgit\\s+rebase\\s+(--interactive|-i)\\b'],
    safer_alternative: 'Stack the change into a new commit',
  },
  {
    id: 'FORBID-NO-VERIFY',
    action: 'Any `--no-verify` flag',
    rationale: 'Bypasses hooks',
    severity: 'high',
    detect_patterns: ['\\b--no-verify\\b'],
    safer_alternative: 'Fix the underlying hook failure',
  },
  {
    id: 'FORBID-NO-GPG-SIGN',
    action: 'Any `--no-gpg-sign` flag',
    rationale: 'Bypasses signing',
    severity: 'high',
    detect_patterns: ['\\b--no-gpg-sign\\b', 'commit\\.gpgsign=false'],
    safer_alternative: 'Configure signing in the environment',
  },
  {
    id: 'FORBID-DELETE-BRANCH',
    action: 'Deleting any branch',
    rationale: 'Loss of work',
    severity: 'high',
    detect_patterns: ['\\bgit\\s+branch\\s+-D\\b', '\\bgit\\s+push\\s+.*--delete\\b'],
    safer_alternative: 'Archive the branch; merge first if work survives',
  },
  {
    id: 'FORBID-DROP-PROD',
    action: '`DROP TABLE` / `DROP DATABASE` / `TRUNCATE` outside dev',
    rationale: 'Data loss',
    severity: 'critical',
    detect_patterns: ['\\bDROP\\s+TABLE\\b', '\\bDROP\\s+DATABASE\\b', '\\bTRUNCATE\\s+TABLE\\b'],
    allowed_change_line_patterns: [
      '\\b(?:DROP\\s+(?:TABLE|DATABASE)|TRUNCATE\\s+TABLE)\\s+(?:IF\\s+EXISTS\\s+)?(?:devai_task_[A-Za-z0-9_]+\\b|devai_task_<id>|devai_template\\b)(?=\\s*(?:[\\"\'`]|;|$))',
    ],
    safer_alternative: 'Soft-delete; run on dev with verified backup',
  },
  {
    id: 'FORBID-RM-RF',
    action: '`rm -rf` on uncommitted work',
    rationale: 'Data loss',
    severity: 'high',
    detect_patterns: ['\\brm\\s+-rf\\b'],
    safer_alternative: 'Commit first; rm -rf only on confirmed paths',
  },
  {
    id: 'FORBID-DELETE-AUTHORITY-DOCS',
    action:
      'Deleting law, product intent, runtime audit output, or machine proofs outside the owning authority path',
    rationale: 'Authority violation',
    severity: 'critical',
    detect_patterns: [
      '\\b(?:git\\s+rm|rm)\\s+[^\\n]*(?:law|product|record|\\.devai/local/rounds)/',
    ],
    safer_alternative: 'Use the owning role and explicit action authority',
  },
  {
    id: 'FORBID-EXTERNAL-MESSAGES',
    action: 'Sending external messages (Slack, email, GitHub issue comments outside the PR)',
    rationale: 'Visible action',
    severity: 'medium',
    detect_patterns: ['\\b(?:slack|sendmail|mail)\\b', '\\bgh\\s+(?:issue|pr)\\s+comment\\b'],
    safer_alternative: 'Comment in the PR; let a human relay externally',
  },
  {
    id: 'FORBID-CI-WITHOUT-ADR',
    action: 'Modifying CI/CD pipelines without explicit review',
    rationale: 'Gate weakening',
    severity: 'high',
    detect_patterns: ['(?:\\.github/workflows/|scripts/(?:run-ci-stages|check-workflows)\\.mjs)'],
    safer_alternative: 'Record the gate change rationale and obtain explicit review',
  },
  {
    id: 'FORBID-SECRETS-PROD',
    action: 'Modifying KMS, IAM, SSM, Secrets Manager in stage or prod',
    rationale: 'Security surface',
    severity: 'critical',
    detect_patterns: ['\\baws\\s+(?:kms|iam|ssm|secretsmanager)\\b'],
    safer_alternative: 'Use the ops authority path with per-action authorisation',
  },
  {
    id: 'FORBID-PUBLISH',
    action: '`npm publish` / `pnpm publish` (or equivalent)',
    rationale: 'Release action',
    severity: 'high',
    detect_patterns: ['\\b(npm|pnpm|yarn)\\s+publish\\b'],
    safer_alternative: 'Release via the platform pipeline',
  },
  {
    id: 'FORBID-AWS-DELETE-PROD',
    action: '`aws s3 rm`, `aws s3 sync --delete`, `aws ecs delete-*` outside dev',
    rationale: 'Data/service loss',
    severity: 'critical',
    detect_patterns: ['\\baws\\s+s3\\s+rm\\b', '\\baws\\s+s3\\s+sync\\s+.*--delete\\b'],
    safer_alternative: 'Soft-delete + dev verification first',
  },
  {
    id: 'FORBID-MUTATE-INVARIANTS',
    action: 'Modifying law or committed policy materializations without Architect authority',
    rationale: 'Constitutional change',
    severity: 'critical',
    detect_patterns: [
      '\\b(?:git\\s+(?:add|rm)|rm)\\s+[^\\n]*(?:law/|product/|record/|\\.devai/(?:config|local/rounds)/)',
    ],
    safer_alternative: 'Use Architect authority and record the current rationale',
  },
] as const;

export interface ForbiddenActionFinding {
  readonly forbidden_id: string;
  readonly source: 'commit-message' | 'commit-change' | 'commit-author-email' | 'reflog';
  readonly ref: string;
  readonly matched: string;
  readonly message: string;
}

export interface ScanForbiddenOptions {
  readonly repoRoot: string;
  /** Max commits to scan. Default 50. */
  readonly maxCommits?: number;
  /** Scan every commit strictly after this verified commit instead of a trailing count. */
  readonly sinceRef?: string;
  /** Override the registry path. */
  readonly registryPath?: string;
}

export interface ScanForbiddenResult {
  readonly registry_entries: number;
  readonly findings: readonly ForbiddenActionFinding[];
}

const GIT_INSPECTION_MAX_BUFFER = 16 * 1024 * 1024;

function activeAdrAffectedRules(repoRoot: string): ReadonlySet<string> {
  const adrDir = join(repoRoot, 'law', 'adr');
  if (!existsSync(adrDir)) return new Set();
  const affected = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(adrDir).filter((file) => /^ADR-\d{3}-.+\.md$/u.test(file));
  } catch {
    return affected;
  }
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(adrDir, file), 'utf8');
    } catch {
      continue;
    }
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
    if (frontmatter === undefined) continue;
    if (!/^id: ADR-\d{3}$/mu.test(frontmatter)) continue;
    if (!/^type: adr$/mu.test(frontmatter)) continue;
    if (!/^status: active$/mu.test(frontmatter)) continue;
    const block = frontmatter.match(/^affected_rules:\n((?: {2}- .+\n?)+)/mu)?.[1];
    if (block === undefined) continue;
    for (const line of block.split('\n')) {
      const rule = line.match(/^ {2}- ([^\s].*)$/u)?.[1];
      if (rule !== undefined && !rule.startsWith('/') && !rule.split('/').includes('..')) {
        affected.add(rule);
      }
    }
  }
  return affected;
}

export function loadForbiddenRegistry(path: string): ForbiddenActionEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { actions?: ForbiddenActionEntry[] };
    return parsed.actions ?? [];
  } catch {
    return [];
  }
}

export function loadForbiddenWaivers(path: string): ForbiddenActionWaiver[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { waivers?: ForbiddenActionWaiver[] };
    return parsed.waivers ?? [];
  } catch {
    return [];
  }
}

export interface ForbiddenCoverageResult {
  readonly canonical_total: number;
  readonly present: readonly string[];
  readonly waived: readonly ForbiddenActionWaiver[];
  /** Canonical ids absent from `actions` AND absent from `waivers` — the real gap. */
  readonly unwaived_missing: readonly string[];
  readonly ok: boolean;
}

function hasValidPatterns(value: unknown, required: boolean): value is readonly string[] {
  if (value === undefined) return !required;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((pattern) => {
    if (typeof pattern !== 'string') return false;
    try {
      new RegExp(pattern, 'i');
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * D-123 (item 6): compares a repo's actual registry against
 * `CANONICAL_FORBIDDEN_ACTIONS`. A canonical id can be absent for two
 * reasons: it was silently dropped (a gap `devai check
 * forbidden-actions` should surface), or it was explicitly waived
 * with a reason (a repo's own governed choice, not a gap). Extending
 * the registry with client-specific entries never affects this check
 * — only the canonical set's own coverage is measured.
 */
export function checkForbiddenRegistryCoverage(registryPath: string): ForbiddenCoverageResult {
  const registry = loadForbiddenRegistry(registryPath);
  const waivers = loadForbiddenWaivers(registryPath);
  const presentIds = new Set(
    registry
      .filter(
        (entry) =>
          hasValidPatterns(entry.detect_patterns, true) &&
          hasValidPatterns(entry.allowed_change_line_patterns, false),
      )
      .map((entry) => entry.id),
  );
  const waivedIds = new Set(waivers.map((w) => w.id));
  const present = CANONICAL_FORBIDDEN_ACTIONS.filter((e) => presentIds.has(e.id)).map((e) => e.id);
  const unwaivedMissing = CANONICAL_FORBIDDEN_ACTIONS.filter(
    (e) => !presentIds.has(e.id) && !waivedIds.has(e.id),
  ).map((e) => e.id);
  const waived = waivers.filter((w) => CANONICAL_FORBIDDEN_ACTIONS.some((e) => e.id === w.id));
  return {
    canonical_total: CANONICAL_FORBIDDEN_ACTIONS.length,
    present,
    waived,
    unwaived_missing: unwaivedMissing,
    ok: unwaivedMissing.length === 0,
  };
}

/**
 * Scan recent commits for forbidden-pattern matches in messages and
 * committed path/patch evidence. History inspection fails closed so a
 * missing Git binary, non-repository root, or unreadable commit cannot
 * masquerade as a clean scan.
 */
export function scanForbiddenActions(opts: ScanForbiddenOptions): ScanForbiddenResult {
  const findings: ForbiddenActionFinding[] = [];
  const max = opts.maxCommits ?? 50;
  const authoredRegistry = join(opts.repoRoot, 'law/policy/forbidden-actions.json');
  const registryPath =
    opts.registryPath ??
    (existsSync(authoredRegistry)
      ? authoredRegistry
      : join(opts.repoRoot, '.devai/config/forbidden-actions.json'));
  let registry: ForbiddenActionEntry[];
  if (!existsSync(registryPath)) {
    return {
      registry_entries: 0,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-REGISTRY-INVALID',
          source: 'commit-change',
          ref: registryPath,
          matched: '',
          message: 'forbidden-action registry is missing',
        },
      ],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      actions?: ForbiddenActionEntry[];
    };
    if (!Array.isArray(parsed.actions)) throw new Error('actions must be an array');
    registry = parsed.actions;
  } catch {
    return {
      registry_entries: 0,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-REGISTRY-INVALID',
          source: 'commit-change',
          ref: registryPath,
          matched: '',
          message: 'forbidden-action registry bytes are malformed',
        },
      ],
    };
  }
  if (registry.length === 0) {
    return {
      registry_entries: 0,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-REGISTRY-INVALID',
          source: 'commit-change',
          ref: registryPath,
          matched: '',
          message: 'forbidden-action registry has no actions',
        },
      ],
    };
  }
  // Compile patterns once.
  const compiled = registry
    .filter((e) => Array.isArray(e.detect_patterns) && e.detect_patterns.length > 0)
    .map((e) => ({
      id: e.id,
      action: e.action,
      patterns: (e.detect_patterns ?? [])
        .map((p) => {
          try {
            return new RegExp(p, 'i');
          } catch {
            return null;
          }
        })
        .filter((p): p is RegExp => p !== null),
      allowedChangeLinePatterns: Array.isArray(e.allowed_change_line_patterns)
        ? e.allowed_change_line_patterns
            .map((p) => {
              try {
                return new RegExp(p, 'i');
              } catch {
                return null;
              }
            })
            .filter((p): p is RegExp => p !== null)
        : [],
      allowedChangeLinePatternsValid: hasValidPatterns(e.allowed_change_line_patterns, false),
    }));
  if (
    compiled.length !== registry.length ||
    compiled.some((entry) => entry.patterns.length === 0 || !entry.allowedChangeLinePatternsValid)
  ) {
    return {
      registry_entries: registry.length,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-REGISTRY-INVALID',
          source: 'commit-change',
          ref: registryPath,
          matched: '',
          message:
            'every forbidden action must have valid detection patterns and valid non-empty allowed change-line patterns when provided',
        },
      ],
    };
  }

  // Read either the explicitly bounded range or the recent commit log via git.
  let log: string;
  try {
    const revision =
      opts.sinceRef === undefined
        ? [`-n${String(max)}`]
        : [
            `${execFileSync('git', ['rev-parse', '--verify', `${opts.sinceRef}^{commit}`], {
              cwd: opts.repoRoot,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()}..HEAD`,
          ];
    log = execFileSync('git', ['log', ...revision, '--pretty=format:%H%x00%an%x00%P%x00%B%x1e'], {
      cwd: opts.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      registry_entries: registry.length,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-SCAN-UNAVAILABLE',
          source: 'commit-change',
          ref: 'git-log',
          matched: '',
          message: 'committed history could not be inspected',
        },
      ],
    };
  }
  const commits = log
    .split('\x1e')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const activeAdrRules = activeAdrAffectedRules(opts.repoRoot);
  for (const c of commits) {
    const nul = c.indexOf('\x00');
    if (nul === -1) continue;
    const sha = c.slice(0, nul);
    const authorEnd = c.indexOf('\x00', nul + 1);
    if (authorEnd === -1) continue;
    const author = c.slice(nul + 1, authorEnd);
    const parentsEnd = c.indexOf('\x00', authorEnd + 1);
    if (parentsEnd === -1) continue;
    const parents = c
      .slice(authorEnd + 1, parentsEnd)
      .split(' ')
      .filter(Boolean);
    const body = c.slice(parentsEnd + 1);
    let operations: string;
    let patch: string;
    let changedPaths: string[];
    try {
      let treeIdenticalToParent = false;
      if (parents.length > 1) {
        const trees = execFileSync(
          'git',
          ['rev-parse', `${sha}^{tree}`, ...parents.map((parent) => `${parent}^{tree}`)],
          {
            cwd: opts.repoRoot,
            encoding: 'utf8',
            maxBuffer: GIT_INSPECTION_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
          .split('\n')
          .filter(Boolean);
        const [mergeTree, ...parentTrees] = trees;
        treeIdenticalToParent =
          mergeTree !== undefined && parentTrees.some((parentTree) => parentTree === mergeTree);
      }
      if (treeIdenticalToParent) {
        changedPaths = [];
        operations = '';
        patch = '';
      } else {
        const nameStatus = execFileSync(
          'git',
          ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-m', sha],
          {
            cwd: opts.repoRoot,
            encoding: 'utf8',
            maxBuffer: GIT_INSPECTION_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        changedPaths = nameStatus
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => line.split('\t').slice(1));
        operations = nameStatus
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [status = '', ...paths] = line.split('\t');
            if ((status.startsWith('R') || status.startsWith('C')) && paths.length >= 2) {
              return `git rm ${paths[0] ?? ''}\ngit add ${paths[1] ?? ''}\n${line}`;
            }
            const path = paths.at(-1) ?? '';
            return `${status.startsWith('D') ? 'git rm' : 'git add'} ${path}\n${line}`;
          })
          .join('\n');
        patch = execFileSync(
          'git',
          [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--no-ext-diff',
            '--unified=0',
            '-p',
            '-m',
            sha,
          ],
          {
            cwd: opts.repoRoot,
            encoding: 'utf8',
            maxBuffer: GIT_INSPECTION_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      }
    } catch {
      findings.push({
        forbidden_id: 'FORBIDDEN-SCAN-UNAVAILABLE',
        source: 'commit-change',
        ref: sha,
        matched: '',
        message: `commit ${sha.slice(0, 12)} change evidence could not be inspected`,
      });
      continue;
    }
    for (const entry of compiled) {
      const protectedPaths = changedPaths.filter((path) =>
        /^(?:law\/|product\/|work\/(?:rounds|audit)\/|record\/|\.devai\/config\/)/u.test(path),
      );
      const inspectorTestOnly =
        author === 'DEVAI Inspector' &&
        changedPaths.length > 0 &&
        changedPaths.every(
          (path) =>
            /(?:^|\/)tests\//u.test(path) || /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path),
        );
      const messageNamesInvariantMutation =
        entry.id === 'FORBID-MUTATE-INVARIANTS' &&
        entry.patterns.some((pattern) => {
          const matches = pattern.test(body);
          pattern.lastIndex = 0;
          return matches;
        });
      if (
        entry.id === 'FORBID-MUTATE-INVARIANTS' &&
        protectedPaths.length === 0 &&
        !messageNamesInvariantMutation
      ) {
        continue;
      }
      if (
        entry.id === 'FORBID-MUTATE-INVARIANTS' &&
        protectedPaths.length > 0 &&
        protectedPaths.every((path) => {
          if (/^(?:law\/|work\/rounds\/)/u.test(path)) return author === 'DEVAI Architect';
          if (path.startsWith('product/')) return author === 'DEVAI Owner';
          if (path.startsWith('work/audit/')) return author === 'DEVAI Auditor';
          if (path.startsWith('record/')) return author === 'DEVAI Machine';
          if (path.startsWith('.devai/config/')) return author === 'DEVAI Engineer';
          return false;
        })
      ) {
        continue;
      }
      if (entry.id === 'FORBID-CI-WITHOUT-ADR') {
        const changedCiPaths = changedPaths.filter((path) =>
          entry.patterns.some((pattern) => {
            const matches = pattern.test(path);
            pattern.lastIndex = 0;
            return matches;
          }),
        );
        const messageNamesCiPath = entry.patterns.some((pattern) => {
          const matches = pattern.test(body);
          pattern.lastIndex = 0;
          return matches;
        });
        if (
          !messageNamesCiPath &&
          changedCiPaths.length > 0 &&
          changedCiPaths.every((path) => activeAdrRules.has(path))
        ) {
          continue;
        }
      }
      const pathEvidenceIds = new Set([
        'FORBID-DELETE-AUTHORITY-DOCS',
        'FORBID-MUTATE-INVARIANTS',
        'FORBID-CI-WITHOUT-ADR',
      ]);
      const changeEvidence = pathEvidenceIds.has(entry.id) ? operations : `${operations}\n${patch}`;
      for (const re of entry.patterns) {
        const messageMatch = re.exec(body);
        re.lastIndex = 0;
        const changeMatch =
          messageMatch === null && !(inspectorTestOnly && !pathEvidenceIds.has(entry.id))
            ? firstUnallowedChangeMatch(re, changeEvidence, entry.allowedChangeLinePatterns)
            : null;
        const m = messageMatch ?? changeMatch;
        if (m === null) continue;
        findings.push({
          forbidden_id: entry.id,
          source: messageMatch === null ? 'commit-change' : 'commit-message',
          ref: sha,
          matched: m[0],
          message: `commit ${sha.slice(0, 12)} matches forbidden pattern: ${entry.action}`,
        });
        // One finding per (commit, entry) is enough.
        break;
      }
    }
  }
  return { registry_entries: registry.length, findings };
}

function firstUnallowedChangeMatch(
  pattern: RegExp,
  evidence: string,
  allowedLinePatterns: readonly RegExp[],
): RegExpExecArray | null {
  if (allowedLinePatterns.length === 0) return pattern.exec(evidence);

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let match = globalPattern.exec(evidence);
  while (match !== null) {
    const lineStart = evidence.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
    const nextNewline = evidence.indexOf('\n', match.index);
    const line = evidence.slice(lineStart, nextNewline === -1 ? evidence.length : nextNewline);
    const relativeMatchStart = match.index - lineStart;
    const relativeMatchEnd = relativeMatchStart + match[0].length;
    const isAllowed = allowedLinePatterns.some((allowedPattern) => {
      const flags = allowedPattern.flags.includes('g')
        ? allowedPattern.flags
        : `${allowedPattern.flags}g`;
      const globalAllowedPattern = new RegExp(allowedPattern.source, flags);
      let allowedMatch = globalAllowedPattern.exec(line);
      while (allowedMatch !== null) {
        const allowedEnd = allowedMatch.index + allowedMatch[0].length;
        if (allowedMatch.index <= relativeMatchStart && allowedEnd >= relativeMatchEnd) return true;
        if (allowedMatch[0].length === 0) globalAllowedPattern.lastIndex += 1;
        allowedMatch = globalAllowedPattern.exec(line);
      }
      return false;
    });
    if (!isAllowed) return match;
    if (match[0].length === 0) globalPattern.lastIndex += 1;
    match = globalPattern.exec(evidence);
  }
  return null;
}
