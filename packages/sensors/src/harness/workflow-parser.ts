import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Shared workflow YAML parser for Phase 28 harness sensors. Walks
 * `.github/workflows/*.yml{,.yaml}` and extracts a minimal typed AST
 * sufficient for the 7 F5 sensors. Line-based (not a full YAML
 * parser) — deliberate choice to avoid adding a yaml dep; the
 * patterns we need are line-anchored and stable enough.
 */

export interface WorkflowAst {
  readonly file: string;
  readonly relativeFile: string;
  /** Path filters declared under any `on.<trigger>.paths:` block (union). */
  readonly onPaths: readonly string[];
  /** Path-ignore filters declared under any `on.<trigger>.paths-ignore:` block. */
  readonly onPathsIgnore: readonly string[];
  /** Whether the workflow has a top-level `permissions:` block. */
  readonly hasPermissionsBlock: boolean;
  /** Whether the workflow has a top-level `concurrency:` block. */
  readonly hasConcurrencyBlock: boolean;
  /** Action references discovered (one per `uses:` line). */
  readonly actionUses: readonly ActionUse[];
  /** Per-job: number of step entries. */
  readonly jobs: readonly WorkflowJob[];
  /** Number of distinct top-level `run:` script invocations. */
  readonly runStepCount: number;
  /** Concatenated `run:` script bodies (best-effort; used by 28.E alignment). */
  readonly runScripts: readonly string[];
  /** Cache-action references seen (any uses: containing 'cache', e.g. actions/cache). */
  readonly hasCache: boolean;
  /** Reusable-workflow uses: `uses: <owner>/<repo>/.github/workflows/*.yml@*` or `./.github/workflows/*.yml`. */
  readonly reusableWorkflowUses: readonly string[];
  /** Composite-action uses: `uses: ./.github/actions/<name>`. */
  readonly compositeActionUses: readonly string[];
}

export interface ActionUse {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly line: number;
}

export interface WorkflowJob {
  readonly name: string;
  readonly stepCount: number;
  readonly matrixDimensions: number;
  /** Total matrix combinations: product of all listed dimensions. */
  readonly matrixCombinations: number;
}

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export function listWorkflowFiles(repoRoot: string, dir?: string): string[] {
  const d = abs(repoRoot, dir ?? '.github/workflows');
  const st = safeStat(d);
  if (st === null || !st.isDirectory()) return [];
  try {
    return readdirSync(d)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => join(d, f))
      .sort();
  } catch {
    return [];
  }
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function isListItem(line: string): boolean {
  return /^\s*-\s/.test(line);
}

function trimComment(line: string): string {
  // Naive: drop everything after a `#` not inside quotes. Good enough for our extractor.
  const i = line.indexOf('#');
  if (i === -1) return line;
  // Don't strip when inside a quoted string (best-effort): look for unbalanced quotes before #.
  const before = line.slice(0, i);
  const dq = (before.match(/"/g) ?? []).length;
  const sq = (before.match(/'/g) ?? []).length;
  if (dq % 2 === 1 || sq % 2 === 1) return line;
  return before.trimEnd();
}

const USES_RE = /^\s*-?\s*uses:\s*([^\s@'"]+)(?:@([^\s'"]+))?/;

function parseUses(line: string, lineNo: number): ActionUse | null {
  const m = line.match(USES_RE);
  if (m === null) return null;
  const target = m[1] ?? '';
  const ref = m[2] ?? '';
  if (target.startsWith('./')) {
    // Local action / reusable workflow — owner '' indicates local.
    return { owner: '', repo: target, ref, line: lineNo };
  }
  const parts = target.split('/');
  if (parts.length < 2) return null;
  const owner = parts[0] ?? '';
  const repo = parts.slice(1).join('/');
  return { owner, repo, ref, line: lineNo };
}

interface CollectedJob {
  name: string;
  stepCount: number;
  matrixSizes: number[];
}

export function parseWorkflow(file: string, content: string, repoRoot: string): WorkflowAst {
  const lines = content.split('\n').map(trimComment);
  const onPaths: string[] = [];
  const onPathsIgnore: string[] = [];
  let hasPermissions = false;
  let hasConcurrency = false;
  const actionUses: ActionUse[] = [];
  const jobs: CollectedJob[] = [];
  const runScripts: string[] = [];
  let runStepCount = 0;
  let hasCache = false;
  const reusable: string[] = [];
  const composites: string[] = [];

  // State for path filter capture.
  let inOnBlock = false;
  let inPaths: 'paths' | 'paths-ignore' | null = null;
  let pathsIndent = -1;
  // State for jobs / steps / matrix.
  let inJobsBlock = false;
  let jobsBaseIndent = -1;
  let currentJob: CollectedJob | null = null;
  let jobBaseIndent = -1;
  let inSteps = false;
  let stepsBaseIndent = -1;
  let inMatrixBlock = false;
  let matrixBaseIndent = -1;
  let currentMatrixKey: string | null = null;
  let currentMatrixSize = 0;
  let matrixKeyIndent = -1;
  // State for run: capture (multi-line scalar).
  let inRun = false;
  let runIndent = -1;
  let runBuffer: string[] = [];

  function flushMatrixKey(): void {
    if (currentMatrixKey !== null && currentJob !== null && currentMatrixSize > 0) {
      currentJob.matrixSizes.push(currentMatrixSize);
    }
    currentMatrixKey = null;
    currentMatrixSize = 0;
  }

  function flushRun(): void {
    if (runBuffer.length > 0) {
      runScripts.push(runBuffer.join('\n'));
      runStepCount += 1;
    }
    inRun = false;
    runBuffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const ind = indentOf(line);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (inRun && ind <= runIndent) flushRun();
      continue;
    }

    // Top-level keys.
    if (ind === 0) {
      flushRun();
      flushMatrixKey();
      inMatrixBlock = false;
      inSteps = false;
      currentJob = null;
      jobsBaseIndent = -1;
      jobBaseIndent = -1;
      inJobsBlock = false;
      inOnBlock = false;
      inPaths = null;
      pathsIndent = -1;
      if (/^on\s*:/.test(trimmed)) inOnBlock = true;
      else if (/^permissions\s*:/.test(trimmed)) hasPermissions = true;
      else if (/^concurrency\s*:/.test(trimmed)) hasConcurrency = true;
      else if (/^jobs\s*:/.test(trimmed)) {
        inJobsBlock = true;
        jobsBaseIndent = 0;
      }
      continue;
    }

    // Run-script capture (multi-line scalar via | or > or single-line).
    if (inRun) {
      if (ind > runIndent) {
        runBuffer.push(line.slice(runIndent + 2)); // best-effort dedent
        continue;
      } else {
        flushRun();
      }
    }

    // on.paths / on.paths-ignore capture.
    if (inOnBlock) {
      const m = trimmed.match(/^paths(?:-ignore)?\s*:/);
      if (m !== null) {
        inPaths = trimmed.startsWith('paths-ignore') ? 'paths-ignore' : 'paths';
        pathsIndent = ind;
        continue;
      }
      if (inPaths !== null && ind > pathsIndent && isListItem(line)) {
        const value = trimmed.replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
        if (value !== '') {
          if (inPaths === 'paths') onPaths.push(value);
          else onPathsIgnore.push(value);
        }
        continue;
      }
      if (inPaths !== null && ind <= pathsIndent) {
        inPaths = null;
        pathsIndent = -1;
      }
    }

    // Job header detection: `<name>:` directly under jobs.
    if (
      inJobsBlock &&
      currentJob === null &&
      ind > jobsBaseIndent &&
      /^[A-Za-z0-9_\-.]+\s*:\s*$/.test(trimmed)
    ) {
      const name = trimmed.replace(/:\s*$/, '');
      currentJob = { name, stepCount: 0, matrixSizes: [] };
      jobBaseIndent = ind;
      jobs.push(currentJob);
      continue;
    }
    // Nested-job recognition for `name:` inside the current job is the same regex; guard via stepCount.

    // steps: marker.
    if (currentJob !== null && /^steps\s*:/.test(trimmed)) {
      inSteps = true;
      stepsBaseIndent = ind;
      continue;
    }
    // strategy.matrix block.
    if (currentJob !== null && /^matrix\s*:/.test(trimmed)) {
      inMatrixBlock = true;
      matrixBaseIndent = ind;
      continue;
    }

    if (inMatrixBlock && currentJob !== null) {
      if (ind <= matrixBaseIndent) {
        flushMatrixKey();
        inMatrixBlock = false;
      } else {
        const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(\[.*\])?\s*$/);
        if (keyMatch !== null && !isListItem(line)) {
          flushMatrixKey();
          currentMatrixKey = keyMatch[1] ?? null;
          matrixKeyIndent = ind;
          const inlineList = keyMatch[2];
          if (inlineList !== undefined) {
            const items = inlineList
              .slice(1, -1)
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            currentMatrixSize = items.length;
            flushMatrixKey();
          } else {
            currentMatrixSize = 0;
          }
        } else if (currentMatrixKey !== null && ind > matrixKeyIndent && isListItem(line)) {
          currentMatrixSize += 1;
        }
      }
    }

    if (inSteps && currentJob !== null) {
      if (ind <= stepsBaseIndent && !isListItem(line) && /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) {
        // Out of steps.
        inSteps = false;
      } else if (isListItem(line) && ind === stepsBaseIndent + 2) {
        currentJob.stepCount += 1;
      }
    }

    // Detect end of current job (a new top-level job key at the same indent).
    if (
      inJobsBlock &&
      currentJob !== null &&
      ind === jobBaseIndent &&
      /^[A-Za-z0-9_\-.]+\s*:\s*$/.test(trimmed) &&
      currentJob.stepCount > 0
    ) {
      // Switching to a new job at the same indent.
      const name = trimmed.replace(/:\s*$/, '');
      flushMatrixKey();
      inMatrixBlock = false;
      inSteps = false;
      currentJob = { name, stepCount: 0, matrixSizes: [] };
      jobs.push(currentJob);
      continue;
    }

    // uses: lines.
    const use = parseUses(line, i + 1);
    if (use !== null) {
      actionUses.push(use);
      if (use.repo.startsWith('./.github/actions/')) composites.push(use.repo);
      else if (use.repo.endsWith('.yml') || use.repo.endsWith('.yaml')) reusable.push(use.repo);
      const path = `${use.owner}/${use.repo}`.toLowerCase();
      if (path.includes('cache')) hasCache = true;
      // Phase 30 lane D refinement: setup-* actions with built-in
      // cache (e.g. actions/setup-node@v4 with `cache: pnpm`) also
      // satisfy the cache-discipline signal. Detect on the action
      // name; treat as cache-eligible if a subsequent `cache:` key
      // appears within ~10 lines of the uses: declaration.
      if (path.includes('actions/setup-')) {
        for (let j = i + 1; j <= Math.min(i + 10, lines.length - 1); j++) {
          if (/^\s*cache\s*:\s*\S+/.test(lines[j] ?? '')) {
            hasCache = true;
            break;
          }
          // Stop at a new step boundary (line starting with `- `).
          if (/^\s*-\s/.test(lines[j] ?? '')) break;
        }
      }
    }

    // run: lines.
    if (/^\s*-?\s*run\s*:/.test(line)) {
      const inline = trimmed.replace(/^-?\s*run\s*:\s*/, '');
      if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-' || inline === '') {
        inRun = true;
        runIndent = ind;
        runBuffer = [];
      } else {
        runScripts.push(inline);
        runStepCount += 1;
      }
    }
  }
  flushRun();
  flushMatrixKey();

  const rel = file.startsWith(repoRoot + '/') ? file.slice(repoRoot.length + 1) : file;
  return {
    file,
    relativeFile: rel,
    onPaths: [...new Set(onPaths)],
    onPathsIgnore: [...new Set(onPathsIgnore)],
    hasPermissionsBlock: hasPermissions,
    hasConcurrencyBlock: hasConcurrency,
    actionUses,
    jobs: jobs.map((j) => {
      const dims = j.matrixSizes.length;
      const combos = j.matrixSizes.reduce((acc, n) => acc * n, 1);
      return {
        name: j.name,
        stepCount: j.stepCount,
        matrixDimensions: dims,
        matrixCombinations: dims === 0 ? 0 : combos,
      };
    }),
    runStepCount,
    runScripts,
    hasCache,
    reusableWorkflowUses: reusable,
    compositeActionUses: composites,
  };
}

function loadCompositeActionFlags(
  repoRoot: string,
  ref: string,
): { hasCache: boolean; actionUses: readonly ActionUse[]; runScripts: readonly string[] } | null {
  const normalized = ref.replace(/^\.\//, '');
  const actionPath = abs(repoRoot, join(normalized, 'action.yml'));
  let content: string;
  try {
    content = readFileSync(actionPath, 'utf8');
  } catch {
    const alt = abs(repoRoot, join(normalized, 'action.yaml'));
    try {
      content = readFileSync(alt, 'utf8');
    } catch {
      return null;
    }
  }
  const parsed = parseWorkflow(actionPath, content, repoRoot);
  return {
    hasCache: parsed.hasCache,
    actionUses: parsed.actionUses,
    runScripts: parsed.runScripts,
  };
}

export function loadWorkflows(repoRoot: string, dir?: string): WorkflowAst[] {
  const files = listWorkflowFiles(repoRoot, dir);
  const out: WorkflowAst[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const wf = parseWorkflow(f, content, repoRoot);
    if (wf.compositeActionUses.length === 0) {
      out.push(wf);
      continue;
    }
    let mergedHasCache = wf.hasCache;
    const mergedActionUses = [...wf.actionUses];
    const mergedRunScripts = [...wf.runScripts];
    for (const ref of wf.compositeActionUses) {
      const composite = loadCompositeActionFlags(repoRoot, ref);
      if (composite === null) continue;
      if (composite.hasCache) mergedHasCache = true;
      mergedActionUses.push(...composite.actionUses);
      mergedRunScripts.push(...composite.runScripts);
    }
    out.push({
      ...wf,
      hasCache: mergedHasCache,
      actionUses: mergedActionUses,
      runScripts: mergedRunScripts,
    });
  }
  return out;
}
