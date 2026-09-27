import { relative } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { git, gitFile, recordHistory } from './history.js';
import {
  parseRecordSource,
  type GovernanceFinding,
  type ParsedGovernanceRecord,
} from './records.js';

function normalizedSealedFrontmatter(record: ParsedGovernanceRecord): string {
  const { status: _lifecycle, superseded_by: _replacement, ...rest } = record.frontmatter;
  return JSON.stringify(rest);
}

function replacementId(record: ParsedGovernanceRecord): string | null {
  const value = record.frontmatter['superseded_by'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sealedTransitionAllowed(
  before: ParsedGovernanceRecord,
  after: ParsedGovernanceRecord,
): boolean {
  const beforeStatus = String(before.frontmatter['status']);
  const afterStatus = String(after.frontmatter['status']);
  const beforeReplacement = replacementId(before);
  const afterReplacement = replacementId(after);

  if (beforeStatus === 'active') {
    if (afterStatus === 'active') return afterReplacement === beforeReplacement;
    if (afterStatus === 'superseded') {
      return beforeReplacement === null && afterReplacement !== null;
    }
    return false;
  }
  return (
    beforeStatus === 'superseded' &&
    afterStatus === beforeStatus &&
    afterReplacement === beforeReplacement
  );
}

export function sealedHistoryFindings(
  repoRoot: string,
  record: ParsedGovernanceRecord,
): GovernanceFinding[] {
  const rel = relative(repoRoot, record.path);
  const history = recordHistory(repoRoot, rel);
  if (history === null || history.length === 0) {
    return [
      {
        code: 'DECISION_HISTORY_UNAVAILABLE',
        message: `${rel} history could not be enumerated completely.`,
        path: rel,
      },
    ];
  }
  let sealed: ParsedGovernanceRecord | undefined;
  let sealIndex = -1;
  for (const [index, entry] of history.entries()) {
    const source = gitFile(repoRoot, entry.commit, entry.path);
    if (source === null) {
      return [
        {
          code: 'DECISION_HISTORY_UNAVAILABLE',
          message: `${rel} revision ${entry.commit}:${entry.path} could not be read.`,
          path: rel,
        },
      ];
    }
    try {
      const candidate = parseRecordSource(entry.path, source);
      if (
        validators.recordMeta(candidate.frontmatter) &&
        ['active', 'superseded'].includes(String(candidate.frontmatter['status']))
      ) {
        sealed = candidate;
        sealIndex = index;
        break;
      }
    } catch {
      // A schema-invalid revision cannot establish the sealing boundary.
    }
  }
  if (sealed === undefined || sealIndex < 0) return [];
  const originalSeal = sealed;
  let lockedMutationObserved = false;
  const priorTerminalStates: string[] = [];
  // Validate the exact inspected bytes as the final revision, even before commit.
  const laterHistory: { commit: string | null; path: string }[] = [
    ...history.slice(sealIndex + 1),
    { commit: null, path: record.path },
  ];
  for (const [laterIndex, entry] of laterHistory.entries()) {
    const laterSource =
      entry.commit === null ? record.source : gitFile(repoRoot, entry.commit, entry.path);
    if (laterSource === null) {
      return [
        {
          code: 'DECISION_HISTORY_UNAVAILABLE',
          message: `${rel} revision ${entry.commit}:${entry.path} could not be read.`,
          path: rel,
        },
      ];
    }
    let later: ParsedGovernanceRecord;
    try {
      later = parseRecordSource(entry.path, laterSource);
    } catch (error) {
      return [
        {
          code: 'DECISION_HISTORY_PARSE_INVALID',
          message: `${rel} has malformed post-seal history at ${entry.commit}: ${error instanceof Error ? error.message : String(error)}.`,
          path: rel,
        },
      ];
    }
    if (
      later.body !== sealed.body ||
      normalizedSealedFrontmatter(later) !== normalizedSealedFrontmatter(sealed) ||
      !sealedTransitionAllowed(sealed, later)
    ) {
      lockedMutationObserved = true;
    }
    if (
      laterIndex < laterHistory.length - 1 &&
      String(later.frontmatter['status']) === 'superseded'
    ) {
      priorTerminalStates.push(
        `${String(later.frontmatter['status'])}:${replacementId(later) ?? ''}`,
      );
    }
    sealed = later;
  }
  if (lockedMutationObserved) {
    const bytesAndStableFieldsRestored =
      sealed.body === originalSeal.body &&
      normalizedSealedFrontmatter(sealed) === normalizedSealedFrontmatter(originalSeal);
    const fullyRestored =
      bytesAndStableFieldsRestored &&
      String(sealed.frontmatter['status']) === String(originalSeal.frontmatter['status']) &&
      replacementId(sealed) === replacementId(originalSeal);
    const finalTerminalState = `${String(sealed.frontmatter['status'])}:${replacementId(sealed) ?? ''}`;
    const restoredThroughTerminalTransition =
      String(originalSeal.frontmatter['status']) === 'active' &&
      priorTerminalStates.every((state) => state === finalTerminalState) &&
      String(sealed.frontmatter['status']) === 'superseded' &&
      bytesAndStableFieldsRestored &&
      sealedTransitionAllowed(originalSeal, sealed);
    if (!fullyRestored && !restoredThroughTerminalTransition) {
      return [
        {
          code: 'DECISION_LOCKED_BODY_MUTATED',
          message: `${rel} changed after its sealing commit; only a canonical terminal lifecycle transition is allowed.`,
          path: rel,
        },
      ];
    }
  }
  return [];
}

export function closedRoundHistoryFindings(
  repoRoot: string,
  rel: string,
  name: string,
): readonly GovernanceFinding[] {
  const unavailable = (): readonly GovernanceFinding[] => [
    {
      code: 'ROUND_HISTORY_UNAVAILABLE',
      message: `${name} closed history could not be verified completely.`,
      path: rel,
    },
  ];
  const history = git(repoRoot, ['log', '--format=%H', '--reverse', '--', rel]);
  if (history === null || history.length === 0) return unavailable();
  let sealedTree: string | undefined;
  for (const commit of history.split('\n').filter(Boolean)) {
    const tree = git(repoRoot, ['rev-parse', `${commit}:${rel}`]);
    if (tree === null) return unavailable();
    if (sealedTree !== undefined) {
      if (tree !== sealedTree) {
        return [
          {
            code: 'ROUND_ARCHIVE_MUTATED',
            message: `${name} changed after its first closed commit.`,
            path: rel,
          },
        ];
      }
      continue;
    }
    const recordPath = `${rel}/record.md`;
    const population = git(repoRoot, ['ls-tree', '--name-only', commit, '--', recordPath]);
    if (population === null) return unavailable();
    if (population.length === 0) continue; // Working scaffold before a record exists.
    const source = gitFile(repoRoot, commit, recordPath);
    if (source === null) return unavailable();
    let record: ParsedGovernanceRecord;
    try {
      record = parseRecordSource(recordPath, source);
    } catch {
      return unavailable();
    }
    if (record.frontmatter['status'] === 'closed') sealedTree = tree;
  }
  return sealedTree === undefined ? unavailable() : [];
}
