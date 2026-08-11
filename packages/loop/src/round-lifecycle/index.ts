import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { join, relative, resolve } from 'node:path';
import { parseGovernanceRecord } from '../governance-ledger/index.js';

type JsonRecord = Record<string, unknown>;

export class RoundLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RoundLifecycleError';
  }
}

function fail(code: string): never {
  throw new RoundLifecycleError(code);
}

export function normalizeRoundId(value: string | number): string {
  const raw = String(value).trim();
  const number = raw.startsWith('R-') ? raw.slice(2) : raw;
  if (!/^[0-9]{1,4}$/u.test(number) || Number(number) < 1) fail('ROUND_ID_INVALID');
  const id = `R-${number.padStart(4, '0')}`;
  return id;
}

function localRoundDir(repoRoot: string, id: string): string {
  return join(resolve(repoRoot), 'work/rounds', id);
}

function roundNumber(id: string): string {
  return String(Number(id.slice('R-'.length)));
}

export interface RoundScaffoldResult {
  readonly ok: true;
  readonly id: string;
  readonly path: string;
  readonly files: readonly string[];
}

export function scaffoldGovernedRound(options: {
  readonly repoRoot: string;
  readonly round: string | number;
}): RoundScaffoldResult {
  const repoRoot = resolve(options.repoRoot);
  const id = normalizeRoundId(options.round);
  const dir = localRoundDir(repoRoot, id);
  if (existsSync(dir)) {
    fail('ROUND_ALREADY_EXISTS');
  }
  for (const child of ['inputs', 'audit', 'prompts']) {
    mkdirSync(join(dir, child), { recursive: true });
  }
  const planPath = join(dir, 'plan.md');
  const promptPath = join(dir, 'prompts/00-orchestrator.md');
  writeFileSync(
    planPath,
    [
      `# Round ${roundNumber(id)} plan`,
      '',
      '**Status:** scaffolded local working paper; not durable governance authority.',
      '',
      '## Goal',
      '',
      '(declare the approved goal)',
      '',
      '## Waves',
      '',
      '(declare role-separated waves and gates)',
      '',
    ].join('\n'),
  );
  writeFileSync(
    promptPath,
    [
      `# ${id} orchestrator`,
      '',
      'Deterministic local scaffold. Replace this working prompt before execution.',
      '',
    ].join('\n'),
  );
  return {
    ok: true,
    id,
    path: relative(repoRoot, dir),
    files: [relative(repoRoot, planPath), relative(repoRoot, promptPath)],
  };
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  fail('ROUND_RECORD_SERIALIZATION_UNSUPPORTED');
}

function inlineArray(value: unknown): string {
  if (!Array.isArray(value)) fail('ROUND_RECORD_SERIALIZATION_UNSUPPORTED');
  return `[${value.map((item) => yamlScalar(item)).join(', ')}]`;
}

function renderRoundRecord(record: JsonRecord): string {
  const isolation = record['isolation'] as JsonRecord;
  const waves = record['waves'] as JsonRecord[];
  const lines = [
    '---',
    `schemaVersion: ${yamlScalar(record['schemaVersion'])}`,
    `id: ${yamlScalar(record['id'])}`,
    `title: ${yamlScalar(record['title'])}`,
    `type: ${yamlScalar(record['type'])}`,
    `kind: ${yamlScalar(record['kind'])}`,
    `status: ${yamlScalar(record['status'])}`,
    `date: ${yamlScalar(record['date'])}`,
    `authority: ${yamlScalar(record['authority'])}`,
    `goal: ${yamlScalar(record['goal'])}`,
    `declared_by: ${yamlScalar(record['declared_by'])}`,
  ];
  for (const key of ['closed_by', 'phase_closure', 'merged_as'] as const) {
    if (record[key] !== undefined) lines.push(`${key}: ${yamlScalar(record[key])}`);
  }
  lines.push(
    'isolation:',
    `  kind: ${yamlScalar(isolation['kind'])}`,
    `  branch: ${yamlScalar(isolation['branch'])}`,
    `  base_sha: ${yamlScalar(isolation['base_sha'])}`,
    'waves:',
  );
  for (const wave of waves) {
    lines.push(
      `  - id: ${yamlScalar(wave['id'])}`,
      `    title: ${yamlScalar(wave['title'])}`,
      `    roles: ${inlineArray(wave['roles'])}`,
      `    type: ${yamlScalar(wave['type'])}`,
      `    lock_scopes: ${inlineArray(wave['lock_scopes'])}`,
      `    gates: ${inlineArray(wave['gates'])}`,
    );
  }
  lines.push(
    `gates: ${inlineArray(record['gates'])}`,
    `orchestrator_prompt: ${yamlScalar(record['orchestrator_prompt'])}`,
    `plan_path: ${yamlScalar(record['plan_path'])}`,
    '---',
    '',
    `# ${String(record['id'])}`,
    '',
    'Canonical round lifecycle record. The frontmatter is schema-authoritative.',
    '',
  );
  return lines.join('\n');
}

export function declareGovernedRound(options: {
  readonly repoRoot: string;
  readonly round: string | number;
  readonly recordPath: string;
}): Readonly<{ ok: true; id: string; path: string; record: JsonRecord }> {
  const repoRoot = resolve(options.repoRoot);
  const id = normalizeRoundId(options.round);
  const dir = localRoundDir(repoRoot, id);
  if (!existsSync(dir)) fail('ROUND_SCAFFOLD_MISSING');
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(resolve(options.recordPath), 'utf8'));
  } catch {
    fail('ROUND_RECORD_INPUT_INVALID');
  }
  if (!validators.recordMeta(record)) fail('ROUND_RECORD_SCHEMA_INVALID');
  const typed = record as JsonRecord;
  if (typed['id'] !== id) fail('ROUND_RECORD_ID_MISMATCH');
  const target = join(dir, 'record.md');
  writeFileSync(target, renderRoundRecord(typed));
  return { ok: true, id, path: relative(repoRoot, target), record: typed };
}

export function governedRoundStatus(options: {
  readonly repoRoot: string;
  readonly round: string | number;
}): Readonly<{
  ok: true;
  id: string;
  location: 'active' | 'closed';
  path: string;
  record: JsonRecord;
}> {
  const repoRoot = resolve(options.repoRoot);
  const id = normalizeRoundId(options.round);
  const local = localRoundDir(repoRoot, id);
  const path = join(local, 'record.md');
  if (!existsSync(path)) fail('ROUND_RECORD_NOT_FOUND');
  const parsed = parseGovernanceRecord(path);
  if (!validators.recordMeta(parsed.frontmatter)) fail('ROUND_RECORD_SCHEMA_INVALID');
  const location = parsed.frontmatter['status'] === 'closed' ? 'closed' : 'active';
  return {
    ok: true,
    id,
    location,
    path: relative(repoRoot, path),
    record: parsed.frontmatter as JsonRecord,
  };
}

function readJson(path: string, code: string): JsonRecord {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
  } catch {
    fail(code);
  }
}

function decisionExists(repoRoot: string, decision: string): boolean {
  if (existsSync(join(repoRoot, 'law/adr', `${decision}.md`))) return true;
  if (existsSync(join(repoRoot, 'law/register', `${decision}.md`))) return true;
  const register = join(repoRoot, 'law/register/DECISIONS.md');
  if (!existsSync(register)) return false;
  if (!/^[A-Z]+-[0-9]+$/u.test(decision)) return false;
  return new RegExp(`^###\\s+${decision}\\b`, 'mu').test(readFileSync(register, 'utf8'));
}

function assertClosePreconditions(repoRoot: string, id: string, source: string): JsonRecord {
  const recordPath = join(source, 'record.md');
  if (!existsSync(recordPath)) fail('ROUND_ARCHIVE_RECORD_MISSING');
  const parsed = parseGovernanceRecord(recordPath);
  if (!validators.recordMeta(parsed.frontmatter)) fail('ROUND_ARCHIVE_RECORD_INVALID');
  const record = parsed.frontmatter as JsonRecord;
  if (record['id'] !== id) fail('ROUND_ARCHIVE_RECORD_ID_MISMATCH');
  if (record['status'] !== 'closed') fail('ROUND_ARCHIVE_RECORD_NOT_CLOSED');
  const declaredBy = String(record['declared_by']);
  const closedBy = String(record['closed_by']);
  for (const decision of [declaredBy, closedBy]) {
    if (!decisionExists(repoRoot, decision)) {
      fail(`ROUND_ARCHIVE_DECISION_MISSING:${decision}`);
    }
  }
  const closureId = String(record['phase_closure']);
  const closurePath = join(repoRoot, 'record/proofs/compliance/closures', `${closureId}.json`);
  if (!existsSync(closurePath)) fail(`ROUND_ARCHIVE_PHASE_CLOSURE_MISSING:${closureId}`);
  const closure = readJson(closurePath, 'ROUND_ARCHIVE_PHASE_CLOSURE_INVALID');
  if (!validators.phaseClosure(closure)) fail('ROUND_ARCHIVE_PHASE_CLOSURE_INVALID');
  if (
    closure['round_id'] !== id ||
    closure['declaring_decision'] !== declaredBy ||
    closure['closing_decision'] !== closedBy ||
    closure['merged_as'] !== record['merged_as']
  ) {
    fail('ROUND_ARCHIVE_PHASE_CLOSURE_MISMATCH');
  }
  const phaseLedger = join(repoRoot, 'record/derived/indexes/rounds.md');
  if (!existsSync(phaseLedger) || !readFileSync(phaseLedger, 'utf8').includes(closureId)) {
    fail('ROUND_ARCHIVE_PHASE_LEDGER_MISSING');
  }
  const closureGates = closure['gates'] as JsonRecord;
  for (const gate of record['gates'] as string[]) {
    const verdict = closureGates[gate] as JsonRecord | undefined;
    if (verdict?.['status'] !== 'pass') fail(`ROUND_ARCHIVE_GATE_NOT_GREEN:${gate}`);
  }
  if (
    (closure['validation_criteria'] as JsonRecord[]).some(
      (criterion) => criterion['verdict'] === 'fail',
    )
  ) {
    fail('ROUND_ARCHIVE_VALIDATION_NOT_GREEN');
  }
  for (const key of ['plan_path', 'orchestrator_prompt'] as const) {
    const relativePath = String(record[key]);
    const resolved = resolve(source, relativePath);
    if (!resolved.startsWith(`${source}/`) || !existsSync(resolved)) {
      fail(`ROUND_ARCHIVE_REQUIRED_ARTIFACT_MISSING:${relativePath}`);
    }
  }
  return record;
}

export function appendCloseState(source: string, record: JsonRecord): string {
  const path = join(source, 'close-state.jsonl');
  const state = {
    schemaVersion: '1.0.0',
    round_id: record['id'],
    status: 'closed',
    closing_decision: record['closed_by'],
    phase_closure: record['phase_closure'],
    merged_as: record['merged_as'],
  };
  const line = `${JSON.stringify(state)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === line) return path;
    fail('ROUND_CLOSE_STATE_CONFLICT');
  }
  appendFileSync(path, line, { encoding: 'utf8', flag: 'ax' });
  return path;
}

export function closeGovernedRound(options: {
  readonly repoRoot: string;
  readonly round: string | number;
}): Readonly<{ ok: true; id: string; path: string; close_state: string }> {
  const repoRoot = resolve(options.repoRoot);
  const id = normalizeRoundId(options.round);
  const source = localRoundDir(repoRoot, id);
  if (!existsSync(source)) fail('ROUND_ARCHIVE_SOURCE_MISSING');
  const record = assertClosePreconditions(repoRoot, id, source);
  const closeState = appendCloseState(source, record);
  return {
    ok: true,
    id,
    path: relative(repoRoot, source),
    close_state: relative(repoRoot, closeState),
  };
}

export function scaffoldDecisionRecord(options: {
  readonly repoRoot: string;
  readonly title?: string;
  readonly round?: string;
  readonly now?: string;
}): Readonly<{ ok: true; id: string; path: string }> {
  const repoRoot = resolve(options.repoRoot);
  const recordsDir = join(repoRoot, 'law/register');
  mkdirSync(recordsDir, { recursive: true });
  const ids = readdirSync(recordsDir)
    .map((name) => /^D-([0-9]+)\.md$/u.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const id = `D-${String((ids.length === 0 ? 0 : Math.max(...ids)) + 1)}`;
  const title = options.title?.trim() || 'New governance decision';
  const date = (options.now ?? new Date().toISOString()).slice(0, 10);
  const source = [
    '---',
    `id: ${id}`,
    'kind: decision',
    `title: ${JSON.stringify(title)}`,
    'status: proposed',
    'supersedes: []',
    'superseded_by: null',
    'constitution_articles: []',
    `round: ${JSON.stringify(options.round ?? 'pre-round')}`,
    `date: ${date}`,
    '---',
    '',
    `# ${id}. ${title}`,
    '',
    '## Context',
    '',
    '(describe the decision trigger)',
    '',
    '## Decision',
    '',
    '(state the decision)',
    '',
    '## Consequences',
    '',
    '(record consequences and alternatives)',
    '',
  ].join('\n');
  const path = join(recordsDir, `${id}.md`);
  writeFileSync(path, source);
  return { ok: true, id, path: relative(repoRoot, path) };
}
