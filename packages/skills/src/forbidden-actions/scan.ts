import { execFileSync } from '@devai-nyx/authority';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForbiddenActionEntry } from './catalog.js';
import {
  activeAdrAffectedRules,
  loadForbiddenAuthorizations,
  type ForbiddenActionAuthorizationSummary,
} from './authorizations.js';
import { firstUnallowedChangeMatch, hasValidPatterns } from './patterns.js';

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
  /** Override the exact-commit authorization receipt path. */
  readonly authorizationPath?: string;
}

export interface ScanForbiddenResult {
  readonly registry_entries: number;
  readonly findings: readonly ForbiddenActionFinding[];
  readonly authorization_receipts?: ForbiddenActionAuthorizationSummary;
}

const GIT_INSPECTION_MAX_BUFFER = 16 * 1024 * 1024;
const FORBIDDEN_AUTHORIZATION_PATH = 'law/policy/forbidden-action-authorizations.json';

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
    if (
      !Array.isArray(parsed.actions) ||
      parsed.actions.some(
        (entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry),
      )
    ) {
      throw new Error('actions must be an array of objects');
    }
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

  const authorizationPath =
    opts.authorizationPath ?? join(opts.repoRoot, FORBIDDEN_AUTHORIZATION_PATH);
  const authorizationLoad = loadForbiddenAuthorizations(
    authorizationPath,
    new Set(registry.map((entry) => entry.id)),
  );
  if (!authorizationLoad.ok) {
    return {
      registry_entries: registry.length,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-AUTHORIZATION-INVALID',
          source: 'commit-change',
          ref: authorizationPath,
          matched: '',
          message: authorizationLoad.message,
        },
      ],
    };
  }
  const authorizationKeys = new Set(
    authorizationLoad.receipts.map((receipt) => `${receipt.forbidden_id}@${receipt.commit}`),
  );
  const appliedAuthorizationKeys = new Set<string>();

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
    let semanticPatch: string;
    let changedPaths: string[];
    let addedPaths: Set<string>;
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
        semanticPatch = '';
        addedPaths = new Set();
      } else {
        const nameStatus = execFileSync(
          'git',
          ['diff-tree', '--root', '--no-commit-id', '--name-status', '-z', '-r', '-M', '-m', sha],
          {
            cwd: opts.repoRoot,
            encoding: 'utf8',
            maxBuffer: GIT_INSPECTION_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        // NUL framing preserves tabs, newlines, and non-ASCII Git paths verbatim.
        // Line-oriented output quotes those paths and can conceal protected prefixes.
        const fields = nameStatus.split('\0');
        if (fields.pop() !== '') throw new Error('Malformed Git name-status output');
        const changes: { status: string; paths: string[] }[] = [];
        for (let index = 0; index < fields.length;) {
          const status = fields[index++];
          if (status === undefined || !/^(?:[ADMTUXB]|[RC][0-9]+)$/.test(status)) {
            throw new Error('Malformed Git change status');
          }
          const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
          const paths = fields.slice(index, index + pathCount);
          if (paths.length !== pathCount || paths.some((path) => path.length === 0)) {
            throw new Error('Malformed Git change paths');
          }
          index += pathCount;
          changes.push({ status, paths });
        }
        changedPaths = changes.flatMap(({ paths }) => paths);
        addedPaths = new Set(
          changes.filter(({ status }) => status === 'A').flatMap(({ paths }) => paths),
        );
        operations = changes
          .map(({ status, paths }) => {
            const line = [status, ...paths].join('\t');
            if (status.startsWith('R') || status.startsWith('C')) {
              return `git rm ${paths[0]}\ngit add ${paths[1]}\n${line}`;
            }
            return `${status.startsWith('D') ? 'git rm' : 'git add'} ${paths[0]}\n${line}`;
          })
          .join('\n');
        semanticPatch = execFileSync(
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
            '--',
            '.',
            ':(exclude)law/policy/forbidden-actions.json',
            `:(exclude)${FORBIDDEN_AUTHORIZATION_PATH}`,
            ':(exclude).devai/config/forbidden-actions.json',
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
      const protectedPaths = changedPaths.filter((path) => {
        const bootstrapMaterialization =
          addedPaths.has(path) &&
          (path.startsWith('.devai/config/') ||
            [
              'record/proofs/README.md',
              'record/proofs/chain.json',
              'record/derived/inventory/README.md',
            ].includes(path));
        return (
          /^(?:law\/|product\/|work\/(?:rounds|audit)\/|record\/|\.devai\/(?:config|local\/rounds)\/)/u.test(
            path,
          ) && !bootstrapMaterialization
        );
      });
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
          if (path.startsWith('.devai/config/')) {
            return author === 'DEVAI Architect' || author === 'DEVAI Engineer';
          }
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
      const changeEvidence = pathEvidenceIds.has(entry.id)
        ? operations
        : `${operations}\n${semanticPatch}`;
      for (const re of entry.patterns) {
        const messageMatch = re.exec(body);
        re.lastIndex = 0;
        const changeMatch =
          messageMatch === null && !(inspectorTestOnly && !pathEvidenceIds.has(entry.id))
            ? firstUnallowedChangeMatch(re, changeEvidence, entry.allowedChangeLinePatterns)
            : null;
        const m = messageMatch ?? changeMatch;
        if (m === null) continue;
        const authorizationKey = `${entry.id}@${sha}`;
        if (authorizationKeys.has(authorizationKey)) {
          appliedAuthorizationKeys.add(authorizationKey);
          break;
        }
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
  return {
    registry_entries: registry.length,
    findings,
    authorization_receipts: {
      path: authorizationPath,
      declared: authorizationKeys.size,
      applied: [...appliedAuthorizationKeys].sort(),
      unused: [...authorizationKeys].filter((key) => !appliedAuthorizationKeys.has(key)).sort(),
    },
  };
}
