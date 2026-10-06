import { readFileSync } from 'node:fs';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import {
  concurrencyGroupContexts,
  listWorkflowFiles,
  loadWorkflows,
  jobEffectFacts,
} from './harness/workflow-parser.js';

/**
 * F5 harness coherence sensor (28.D; F5×T3). Per design note at
 * docs/theory/architecture/sensors/harness_coherence.md.
 */

export interface HarnessCoherenceOptions {
  readonly repoRoot: string;
  readonly workflowDir?: string;
  readonly maxReviewIncoherence?: number;
  readonly now?: string;
}

const DEFAULT_MAX_REVIEW = 3;

interface ConcurrencyDeclaration {
  readonly group: string;
  readonly cancelInProgress: boolean | null;
}

function concurrencyDeclaration(file: string): ConcurrencyDeclaration | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const block = text.match(/^concurrency\s*:\s*\n((?:[ \t]+.*(?:\n|$))*)/mu);
  if (block === null) return null;
  const body = block[1] ?? '';
  const group = body.match(/^\s+group\s*:\s*(.+?)\s*$/mu)?.[1] ?? '';
  const cancel = body.match(/^\s+cancel-in-progress\s*:\s*(true|false)\s*$/mu)?.[1];
  return {
    group,
    cancelInProgress: cancel === undefined ? null : cancel === 'true',
  };
}

/**
 * The subjects a superseding group may be keyed by: the run's ref, its commit, the pull
 * request it serves, the merge-queue entry it serves, or the release tag it builds.
 */
const SCOPED_SUBJECTS = new Set([
  'github.ref',
  'github.sha',
  'github.event.pull_request.number',
  'github.event.merge_group.head_sha',
  'inputs.release_tag',
]);
/** Contexts that may appear beside a scoped subject but never scope a group alone. */
const UNSCOPED_VALUES = new Set(['github.workflow']);

/**
 * Whether one `${{ … }}` expression always evaluates to a value keyed by a scoped subject.
 * Accepted shapes only: a plain scoped context; `format('literal', …)` with at least one
 * scoped argument and every argument a plain allowlisted context; and
 * `<context> == 'literal' && <scoped> || <scoped>`, where both branches are scoped. A
 * comparison as the value, any other operator, or any other context is unproved.
 */
function scopedExpression(expression: string): boolean {
  const token = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_.-]*)|(==|&&|\|\||[(),]))/uy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (!match) {
      if (expression.slice(offset).trim() !== '') return false;
      break;
    }
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    offset = token.lastIndex;
  }
  let cursor = 0;
  // A scoped value: a plain scoped context, or format() over plain contexts with one scoped.
  function value(): boolean {
    const head = tokens[cursor++];
    if (head === undefined) return false;
    if (SCOPED_SUBJECTS.has(head)) return true;
    if (head !== 'format' || tokens[cursor++] !== '(') return false;
    if (!tokens[cursor++]?.startsWith("'")) return false;
    let scoped = false;
    while (tokens[cursor] === ',') {
      cursor++;
      const argument = tokens[cursor++] ?? '';
      if (SCOPED_SUBJECTS.has(argument)) scoped = true;
      else if (!UNSCOPED_VALUES.has(argument)) return false;
    }
    return tokens[cursor++] === ')' && scoped;
  }
  function condition(): boolean {
    const left = tokens[cursor++] ?? '';
    if (!/^github\.[a-z_.]+$/u.test(left) || tokens[cursor++] !== '==') return false;
    return tokens[cursor++]?.startsWith("'") === true;
  }
  const start = cursor;
  if (value() && cursor === tokens.length) return true;
  cursor = start;
  return (
    condition() &&
    tokens[cursor++] === '&&' &&
    value() &&
    tokens[cursor++] === '||' &&
    value() &&
    cursor === tokens.length
  );
}

/**
 * A superseding group cancels the older runs that share it, so it must be keyed by the run's
 * own subject (#325): every `${{ … }}` part must be a proved shape, and at least one must be
 * scoped. Literal text between parts is free; a literal look-alike of a context never counts.
 */
export function supersedingGroupScoped(group: string): boolean {
  if (concurrencyGroupContexts(group) === undefined) return false;
  const parts = [...group.matchAll(/\$\{\{(.*?)\}\}/gu)].map((match) => (match[1] ?? '').trim());
  // A plain unscoped context such as github.workflow may sit beside a scoped part.
  const proved = parts.every((part) => UNSCOPED_VALUES.has(part) || scopedExpression(part));
  return proved && parts.some((part) => scopedExpression(part));
}

function requiresSerialization(relativeFile: string, file: string): boolean {
  if (/release/iu.test(relativeFile)) return true;
  try {
    return /^\s{2}schedule\s*:/mu.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export function senseHarnessCoherence(opts: HarnessCoherenceOptions): SensorReading {
  const maxReview = opts.maxReviewIncoherence ?? DEFAULT_MAX_REVIEW;
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const findings: SensorFinding[] = [];
  // Fail closed: a listed workflow the loader could not read is never silently dropped.
  const loaded = new Set(workflows.map((workflow) => workflow.file));
  const unreadable = listWorkflowFiles(opts.repoRoot, opts.workflowDir).filter(
    (file) => !loaded.has(file),
  );
  for (const file of unreadable)
    findings.push({
      severity: 'error',
      code: 'HARNESS_COHERENCE_WORKFLOW_UNREADABLE',
      message: `${file} could not be read; its concurrency coherence is unproved.`,
    });

  if (workflows.length === 0 && unreadable.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-coherence',
      sensorKind: 'harness_coherence',
      command: ['devai', 'sense-harness-coherence'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_COHERENCE_NO_WORKFLOWS',
          message: 'No workflows found.',
        },
      ],
      metrics: { workflow_count: 0, incoherence_score: 0 },
    });
  }

  // Action-version drift.
  const actionRefs = new Map<string, Set<string>>();
  for (const wf of workflows) {
    for (const use of wf.actionUses) {
      if (use.owner === '' || use.ref === '') continue;
      const key = `${use.owner}/${use.repo}`;
      let set = actionRefs.get(key);
      if (set === undefined) {
        set = new Set();
        actionRefs.set(key, set);
      }
      set.add(use.ref);
    }
  }
  let driftCount = 0;
  for (const [key, refs] of actionRefs.entries()) {
    if (refs.size > 1) {
      driftCount += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_COHERENCE_ACTION_VERSION_DRIFT',
        message: `Action ${key} pinned to multiple versions across workflows: ${Array.from(refs).join(', ')}`,
      });
    }
  }

  // Permissions discipline.
  const withPerms = workflows.filter((w) => w.hasPermissionsBlock).length;
  const withoutPerms = workflows.length - withPerms;
  const permissionsMixed = withPerms > 0 && withoutPerms > 0 ? 1 : 0;
  if (permissionsMixed === 1) {
    findings.push({
      severity: 'warning',
      code: 'HARNESS_COHERENCE_PERMISSIONS_MIXED',
      message: `${String(withPerms)} workflows declare permissions, ${String(withoutPerms)} do not.`,
    });
  }

  // Concurrency discipline. Ordinary ref-scoped observations cancel stale
  // runs; releases, schedules, and other shared-resource paths serialize.
  const withConcurrency = workflows.filter((w) => w.hasConcurrencyBlock).length;
  const withoutConcurrency = workflows.length - withConcurrency;
  const concurrencyMixed = withConcurrency > 0 && withoutConcurrency > 0 ? 1 : 0;
  if (concurrencyMixed === 1) {
    findings.push({
      severity: 'info',
      code: 'HARNESS_COHERENCE_CONCURRENCY_MIXED',
      message: `${String(withConcurrency)} workflows declare concurrency, ${String(withoutConcurrency)} do not.`,
    });
  }

  let concurrencySemanticIssues = 0;
  for (const workflow of workflows) {
    const declaration = concurrencyDeclaration(workflow.file);
    const serialize = requiresSerialization(workflow.relativeFile, workflow.file);
    const jobs = workflow.jobs.map((job) => ({
      ...job,
      ...jobEffectFacts(readFileSync(workflow.file, 'utf8'), opts.repoRoot, job.name),
    }));
    const effectful = jobs.some((job) => job.effect !== 'read-only');
    const jobLocks =
      jobs.length > 0 &&
      jobs.every((job) => {
        const lock = job.concurrency;
        if (job.effect === 'unknown' || !lock || !lock.group || lock.cancelInProgress === null)
          return false;
        if (job.effect === 'publication')
          return (
            lock.cancelInProgress === false &&
            lock.group.toLowerCase() === 'devai-pages-publication'
          );
        return (
          lock.cancelInProgress === !serialize &&
          (serialize ||
            (supersedingGroupScoped(lock.group) &&
              concurrencyGroupContexts(lock.group)?.includes('github.ref') === true))
        );
      });
    const aliases = jobs.some((a) =>
      jobs.some(
        (b) =>
          a !== b &&
          a.effect !== b.effect &&
          // Two jobs without a job-level group share no lock (#325).
          a.concurrency !== undefined &&
          b.concurrency !== undefined &&
          a.concurrency.group.toLowerCase() === b.concurrency.group.toLowerCase(),
      ),
    );
    const bypass = jobs.some(
      (job) =>
        job.effect === 'publication' &&
        job.needs?.length &&
        /\b(?:always|failure|cancelled)\s*\(/u.test(job.condition ?? ''),
    );
    const valid =
      !aliases &&
      !bypass &&
      jobs.every((j) => j.effect !== 'unknown') &&
      (declaration === null
        ? jobLocks
        : declaration.group.length > 0 &&
          declaration.cancelInProgress === !(serialize || effectful) &&
          (declaration.cancelInProgress !== true || supersedingGroupScoped(declaration.group)) &&
          (!effectful || declaration.cancelInProgress === false));
    if (valid) continue;
    concurrencySemanticIssues += 1;
    findings.push({
      severity: 'warning',
      code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
      message: `${workflow.relativeFile} must declare a non-empty concurrency group with cancel-in-progress: ${serialize ? 'false (serialized)' : 'true (superseding)'}.`,
    });
  }

  const incoherence = driftCount + permissionsMixed + concurrencySemanticIssues + unreadable.length;
  let status: SensorStatus;
  if (incoherence === 0) status = 'pass';
  else if (incoherence <= maxReview) status = 'review';
  else status = 'fail';

  return buildSensorReading({
    sensorName: 'harness-coherence',
    sensorKind: 'harness_coherence',
    command: ['devai', 'sense-harness-coherence'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: workflows.length,
      ...(unreadable.length === 0 ? {} : { unreadable_workflows: unreadable.length }),
      action_version_drift_count: driftCount,
      permissions_mixed: permissionsMixed,
      concurrency_mixed: concurrencyMixed,
      concurrency_semantic_issues: concurrencySemanticIssues,
      incoherence_score: incoherence,
      max_review_incoherence: maxReview,
    },
  });
}
