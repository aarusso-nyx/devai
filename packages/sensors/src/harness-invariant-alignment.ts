import { execFileSync } from '@devai-nyx/authority';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { loadWorkflows } from './harness/workflow-parser.js';

/**
 * F5 harness invariant-alignment sensor (28.E; F5×T4). Per design
 * note at docs/theory/architecture/sensors/harness_invariant_alignment.md.
 */

export interface HarnessInvariantAlignmentOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly workflowDir?: string;
  readonly gateSeverityValue?: string;
  /** Candidate whose successful observations may promote alignment. */
  readonly candidateHead?: string;
  /** Directory containing persisted readings/evidence. */
  readonly evidenceDir?: string;
  /** Maximum age of candidate-bound evidence. Defaults to 24 hours. */
  readonly maxEvidenceAgeHours?: number;
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';

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

interface InvariantRecord {
  readonly id?: string;
  readonly severity?: string;
  readonly measurable_via?: readonly string[];
  readonly measurable_via_mode?: 'any' | 'all';
}

function loadInvariants(dir: string): InvariantRecord[] {
  const st = safeStat(dir);
  if (st === null || !st.isDirectory()) return [];
  const out: InvariantRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, e), 'utf8')) as InvariantRecord);
    } catch {
      // skip
    }
  }
  return out;
}

function actionSpellings(action: string): readonly (readonly string[])[] {
  // Preserve the pre-R18 dashed spelling bridge, but require either spelling
  // to occupy the action position after a recognized DEVAI launcher.
  const words = action.trim().split(/\s+/).filter(Boolean);
  return [words, [words.join('-')]];
}

interface WorkflowRunStep {
  readonly script: string;
  readonly continueOnError: boolean;
  readonly disabled: boolean;
}

/**
 * Normalized alignment-evidence view. R21 accepts this shape directly for
 * host-produced evidence, and also derives it from DEVAI's canonical pair:
 * a SensorReading under `record/proofs/sensor-readings/` plus the matching
 * `sense.readings.record` entry in `record/proofs/chain.json`.
 */
interface AlignmentEvidence {
  readonly id?: unknown;
  readonly command?: unknown;
  readonly status?: unknown;
  readonly candidate_sha?: unknown;
  readonly completed_at?: unknown;
  readonly timestamp?: unknown;
  readonly lifecycle?: unknown;
  readonly env?: { readonly commit?: unknown };
}

function stripYamlComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single && line[i - 1] !== '\\') double = !double;
    else if (char === '#' && !single && !double) return line.slice(0, i).trimEnd();
  }
  return line;
}

function unquoteYamlScalar(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract run steps with the one piece of step metadata that changes their
 * gate semantics. This intentionally remains a small, line-anchored YAML
 * reader like workflow-parser.ts; adding a second YAML dependency just for
 * this sensor would be disproportionate.
 */
function extractRunSteps(content: string): WorkflowRunStep[] {
  const lines = content.split('\n');
  const steps: WorkflowRunStep[] = [];

  for (let start = 0; start < lines.length; start += 1) {
    const first = lines[start] ?? '';
    const startMatch = first.match(/^(\s*)-\s+(?:name|id|run|uses|continue-on-error)\s*:/);
    if (startMatch === null) continue;
    const stepIndent = startMatch[1]?.length ?? 0;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      const next = line.match(/^(\s*)-\s+/);
      if (next !== null && (next[1]?.length ?? 0) <= stepIndent) break;
      const nonEmpty = line.trim();
      const indentation = line.length - line.trimStart().length;
      if (nonEmpty !== '' && indentation < stepIndent) break;
      end += 1;
    }

    const block = lines.slice(start, end);
    const continueOnErrorLine = block.find((line) =>
      /^\s*(?:-\s+)?continue-on-error\s*:/.test(line),
    );
    const continueOnError =
      continueOnErrorLine !== undefined &&
      !/^\s*(?:-\s+)?continue-on-error\s*:\s*(?:false|['"]false['"])(?:\s|#|$)/i.test(
        continueOnErrorLine,
      );
    const disabled = block.some((line) =>
      /^\s*(?:-\s+)?if\s*:\s*(?:false|['"]false['"]|\$\{\{\s*false\s*\}\})(?:\s|#|$)/i.test(line),
    );
    for (let offset = 0; offset < block.length; offset += 1) {
      const line = stripYamlComment(block[offset] ?? '');
      const runMatch = line.match(/^\s*(?:-\s+)?run\s*:\s*(.*)$/);
      if (runMatch === null) continue;
      const raw = (runMatch[1] ?? '').trim();
      if (/^(?:\||>|\|-|>-)?$/.test(raw)) {
        const runIndent = line.length - line.trimStart().length;
        const body: string[] = [];
        for (let bodyIndex = offset + 1; bodyIndex < block.length; bodyIndex += 1) {
          const bodyLine = block[bodyIndex] ?? '';
          const indentation = bodyLine.length - bodyLine.trimStart().length;
          if (bodyLine.trim() !== '' && indentation <= runIndent) break;
          body.push(bodyLine.slice(Math.min(bodyLine.length, runIndent + 2)));
        }
        steps.push({ script: body.join('\n'), continueOnError, disabled });
      } else {
        steps.push({ script: unquoteYamlScalar(raw), continueOnError, disabled });
      }
      break;
    }
    start = end - 1;
  }

  return steps;
}

function loadRunSteps(workflowFiles: readonly string[]): WorkflowRunStep[] {
  const steps: WorkflowRunStep[] = [];
  for (const file of workflowFiles) {
    try {
      steps.push(...extractRunSteps(readFileSync(file, 'utf8')));
    } catch {
      // Workflow parser already treats unreadable files as absent.
    }
  }
  return steps;
}

function shellSegments(script: string): readonly string[] {
  return script
    .split(/\n|&&|;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

function hasNonBindingControlFlow(script: string): boolean {
  return shellSegments(script).some((segment) =>
    /^(?:if|then|elif|else|while|until|case|for|do|done|fi|esac)(?:\s|$)/.test(
      stripYamlComment(segment).trim(),
    ),
  );
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let single = false;
  let double = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (single) {
      if (char === "'") single = false;
      else word += char;
      started = true;
      continue;
    }
    if (double) {
      if (char === '"') {
        double = false;
      } else if (char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return null;
        word += next;
        index += 1;
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (char === "'") {
      single = true;
      started = true;
    } else if (char === '"') {
      double = true;
      started = true;
    } else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      word += next;
      started = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }

  if (single || double) return null;
  if (started) words.push(word);
  return words;
}

function executableName(token: string): string {
  return token.replaceAll('\\', '/').split('/').pop() ?? '';
}

function skipOptions(words: readonly string[], start: number): number {
  let index = start;
  while (words[index]?.startsWith('-') === true) index += 1;
  return index;
}

function devaiActionStart(words: readonly string[]): number | null {
  let index = 0;
  if (executableName(words[index] ?? '') === 'env') {
    index += 1;
    index = skipOptions(words, index);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  } else {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  }

  if (executableName(words[index] ?? '') === 'command') {
    index = skipOptions(words, index + 1);
  }

  const executable = executableName(words[index] ?? '');
  if (executable === 'devai') return index + 1;

  if (executable === 'node' || executable === 'nodejs') {
    index = skipOptions(words, index + 1);
    const script = (words[index] ?? '').replaceAll('\\', '/');
    if (/(?:^|\/)packages\/cli\/(?:dist|src)\/bin\.(?:js|ts)$/.test(script)) {
      return index + 1;
    }
    return null;
  }

  if (executable === 'pnpm') {
    index = skipOptions(words, index + 1);
    if (words[index] === 'exec') index = skipOptions(words, index + 1);
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  if (executable === 'npx') {
    index = skipOptions(words, index + 1);
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  if (executable === 'npm' && words[index + 1] === 'exec') {
    index = skipOptions(words, index + 2);
    if (words[index] === '--') index += 1;
    return executableName(words[index] ?? '') === 'devai' ? index + 1 : null;
  }

  return null;
}

function invokesDevaiAction(command: string, candidate: string): boolean {
  const words = shellWords(command);
  if (words === null) return false;
  const actionStart = devaiActionStart(words);
  if (actionStart === null) return false;
  return actionSpellings(candidate).some(
    (spelling) =>
      spelling.length > 0 &&
      spelling.every(
        (part, offset) => words[actionStart + offset]?.toLowerCase() === part.toLowerCase(),
      ),
  );
}

function isFailClosedExecutableSegment(segment: string, candidate: string): boolean {
  const command = stripYamlComment(segment).trim();
  if (command === '' || command.startsWith('#')) return false;

  // These forms can make an observed command non-binding even when the text
  // occurs in a `run:` body.
  if (/\|\|/.test(command)) return false;
  if (/(?:^|\s)(?:>|>>|1>|1>>|2>|2>>)\s*\/dev\/null(?:\s|$)/.test(command)) return false;
  if (/^set\s+\+e(?:\s|$)/.test(command)) return false;

  const firstToken = shellWords(command)?.[0];
  if (firstToken === undefined) return false;
  const executable = executableName(firstToken);
  if (
    [
      'echo',
      'printf',
      'true',
      ':',
      'if',
      'while',
      'until',
      'case',
      'for',
      'function',
      '!',
    ].includes(executable)
  ) {
    return false;
  }
  if (/(?:^|[^&])&\s*$/.test(command)) return false;

  // A pipeline hides the measured command's status unless pipefail is
  // established in the same run body. Treat it as non-promoting here.
  if (/(^|[^|])\|([^|]|$)/.test(command)) return false;

  return invokesDevaiAction(command, candidate);
}

function hasExecutableMeasurement(steps: readonly WorkflowRunStep[], candidate: string): boolean {
  return steps.some(
    (step) =>
      !step.continueOnError &&
      !step.disabled &&
      !/(?:^|\n)\s*set\s+\+e(?:\s|$)/.test(step.script) &&
      !hasNonBindingControlFlow(step.script) &&
      shellSegments(step.script).some((segment) =>
        isFailClosedExecutableSegment(segment, candidate),
      ),
  );
}

interface EvidenceFile {
  readonly path: string;
  readonly record: AlignmentEvidence;
}

function loadEvidenceFiles(dir: string): EvidenceFile[] {
  const stat = safeStat(dir);
  if (stat === null || !stat.isDirectory()) return [];
  const records: EvidenceFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return records;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const entryStat = safeStat(path);
    if (entryStat?.isDirectory()) {
      records.push(...loadEvidenceFiles(path));
      continue;
    }
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) {
        records.push(
          ...(parsed
            .filter((item) => typeof item === 'object' && item !== null)
            .map((record) => ({ path, record: record as AlignmentEvidence })) as EvidenceFile[]),
        );
      } else if (typeof parsed === 'object' && parsed !== null) {
        records.push({ path, record: parsed as AlignmentEvidence });
      }
    } catch {
      // Malformed evidence cannot promote alignment.
    }
  }
  return records;
}

interface EvidenceChainRecord {
  readonly actor?: unknown;
  readonly action?: unknown;
  readonly status?: unknown;
  readonly timestamp?: unknown;
  readonly context?: { readonly git?: { readonly head_sha?: unknown } };
  readonly artifacts?: ReadonlyArray<{ readonly path?: unknown }>;
  readonly notes?: readonly unknown[];
}

function loadEvidence(repoRoot: string, dir: string): AlignmentEvidence[] {
  const files = loadEvidenceFiles(dir);
  let chainRecords: readonly EvidenceChainRecord[] = [];
  try {
    const chain = JSON.parse(readFileSync(join(repoRoot, 'record/proofs/chain.json'), 'utf8')) as {
      readonly records?: readonly EvidenceChainRecord[];
    };
    chainRecords = chain.records ?? [];
  } catch {
    // Direct normalized records remain valid input; canonical readings without
    // their chain receipt remain deliberately non-promoting.
  }

  return files.map(({ path, record }) => {
    if (typeof record.candidate_sha === 'string') return record;
    const testResultId = record.id;
    const testResultCommit = record.env?.commit;
    if (typeof testResultId === 'string' && typeof testResultCommit === 'string') {
      const receipt = chainRecords.find(
        (entry) =>
          entry.actor === 'devai-record-run' &&
          typeof entry.action === 'string' &&
          entry.action.startsWith('test-run.') &&
          entry.status === 'completed' &&
          entry.context?.git?.head_sha === testResultCommit &&
          entry.notes?.some(
            (note) =>
              typeof note === 'string' && note.startsWith(`test-result id: ${testResultId};`),
          ) === true,
      );
      if (receipt !== undefined) {
        return {
          ...record,
          candidate_sha: testResultCommit,
          completed_at:
            typeof receipt.timestamp === 'string'
              ? receipt.timestamp
              : (record.completed_at ?? record.timestamp),
          lifecycle: record.lifecycle ?? 'supported',
        };
      }
    }
    const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
    const receipt = chainRecords.find(
      (entry) =>
        entry.action === 'sense.readings.record' &&
        entry.artifacts?.some((artifact) => artifact.path === relativePath) === true,
    );
    const candidateSha = receipt?.context?.git?.head_sha;
    if (typeof candidateSha !== 'string') return record;
    return {
      ...record,
      candidate_sha: candidateSha,
      completed_at:
        typeof receipt?.timestamp === 'string'
          ? receipt.timestamp
          : (record.completed_at ?? record.timestamp),
    };
  });
}

function candidateHead(repoRoot: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

function evidenceCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ');
  }
  return '';
}

function isObservationProjectionPath(path: string): boolean {
  return (
    path === 'record/proofs/chain.json' ||
    path.startsWith('record/proofs/sensor-readings/') ||
    path.startsWith('record/proofs/work/test-results/')
  );
}

function evidenceSubjectMatchesCandidate(
  repoRoot: string,
  subjectSha: string,
  candidateSha: string,
): boolean {
  if (subjectSha.toLowerCase() === candidateSha.toLowerCase()) return true;
  if (!/^[0-9a-f]{40}$/i.test(subjectSha) || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
    return false;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', subjectSha, candidateSha], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    const changed = execFileSync('git', ['diff', '--name-only', `${subjectSha}..${candidateSha}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/u)
      .filter(Boolean);
    return changed.length > 0 && changed.every(isObservationProjectionPath);
  } catch {
    return false;
  }
}

function hasFreshCandidateEvidence(
  repoRoot: string,
  records: readonly AlignmentEvidence[],
  candidate: string,
  candidateHead: string,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return false;
  }
  return records.some((record) => {
    if (record.status !== 'pass') return false;
    if (
      typeof record.candidate_sha !== 'string' ||
      !evidenceSubjectMatchesCandidate(repoRoot, record.candidate_sha, candidateHead)
    ) {
      return false;
    }
    if (record.lifecycle === 'experimental') return false;
    const completedAt = record.completed_at ?? record.timestamp;
    if (typeof completedAt !== 'string') return false;
    const completedMs = Date.parse(completedAt);
    if (!Number.isFinite(completedMs) || completedMs > nowMs || nowMs - completedMs > maxAgeMs) {
      return false;
    }
    const command = evidenceCommand(record.command);
    if (hasNonBindingControlFlow(command)) return false;
    return shellSegments(command).some((segment) =>
      isFailClosedExecutableSegment(segment, candidate),
    );
  });
}

export function senseHarnessInvariantAlignment(
  opts: HarnessInvariantAlignmentOptions,
): SensorReading {
  const gateSeverity = opts.gateSeverityValue ?? 'gate';
  const invariants = loadInvariants(
    abs(opts.repoRoot, opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR),
  );
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const runSteps = loadRunSteps(workflows.map((workflow) => workflow.file));
  const resolvedCandidateHead = candidateHead(opts.repoRoot, opts.candidateHead);
  const evidence =
    opts.evidenceDir !== undefined
      ? loadEvidence(opts.repoRoot, abs(opts.repoRoot, opts.evidenceDir))
      : [
          ...loadEvidence(opts.repoRoot, abs(opts.repoRoot, 'record/proofs/sensor-readings')),
          ...loadEvidence(opts.repoRoot, abs(opts.repoRoot, 'record/proofs/work/test-results')),
        ];
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const maxEvidenceAgeHours = opts.maxEvidenceAgeHours ?? 24;
  const maxAgeMs = maxEvidenceAgeHours * 60 * 60 * 1000;

  const gates = invariants.filter((i) => i.severity === gateSeverity);
  if (gates.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-invariant-alignment',
      sensorKind: 'harness_invariant_alignment',
      command: ['devai', 'sense-harness-invariant-alignment'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_INVARIANT_ALIGNMENT_NO_GATES',
          message: `No invariants with severity="${gateSeverity}" found.`,
        },
      ],
      metrics: { gate_invariants: 0, misaligned: 0 },
    });
  }

  const findings: SensorFinding[] = [];
  let misaligned = 0;
  for (const inv of gates) {
    const id = inv.id ?? '<unknown>';
    const candidates = inv.measurable_via ?? [];
    if (candidates.length === 0) {
      misaligned += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_INVARIANT_ALIGNMENT_NO_MEASURABLE_VIA',
        message: `Gate invariant ${id} has no measurable_via[] entries to align against CI.`,
      });
      continue;
    }
    // R18.C.5 (D-133/M1): measurable_via_mode 'all' (invariant schema,
    // Constitution-0.5.0-era addition) marks invariants whose statement
    // needs every listed observation — one verb's textual presence must not
    // count the whole invariant as measured. Default stays 'any' (back-compat).
    const executable = (candidate: string): boolean =>
      hasExecutableMeasurement(runSteps, candidate);
    const matched = (candidate: string): boolean => {
      if (!executable(candidate)) return false;
      if (resolvedCandidateHead === undefined || !/^[0-9a-f]{40}$/i.test(resolvedCandidateHead)) {
        return false;
      }
      return hasFreshCandidateEvidence(
        opts.repoRoot,
        evidence,
        candidate,
        resolvedCandidateHead,
        nowMs,
        maxAgeMs,
      );
    };
    const mode = inv.measurable_via_mode ?? 'any';
    const aligned = mode === 'all' ? candidates.every(matched) : candidates.some(matched);
    if (!aligned) {
      misaligned += 1;
      const missing = mode === 'all' ? candidates.filter((c) => !matched(c)) : candidates;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
        message:
          mode === 'all'
            ? `Gate invariant ${id} requires ALL of measurable_via=[${candidates.join(', ')}] in CI (measurable_via_mode=all); missing: [${missing.join(', ')}].`
            : `Gate invariant ${id} has measurable_via=[${candidates.join(', ')}] but none has an executable fail-closed CI step with fresh successful candidate-bound evidence.`,
      });
    }
  }

  let status: SensorStatus;
  if (misaligned === 0) status = 'pass';
  else if (misaligned <= 2) status = 'review';
  else status = 'fail';

  return buildSensorReading({
    sensorName: 'harness-invariant-alignment',
    sensorKind: 'harness_invariant_alignment',
    command: ['devai', 'sense-harness-invariant-alignment'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      gate_invariants: gates.length,
      misaligned,
      workflow_count: workflows.length,
      executable_run_steps: runSteps.length,
      evidence_records: evidence.length,
      candidate_head_resolved: resolvedCandidateHead !== undefined,
    },
  });
}
