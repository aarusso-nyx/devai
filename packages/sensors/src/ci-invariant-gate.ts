// Invariants: INV-CORE-003, INV-HARNESS-006, INV-DEVAI-002, INV-DEVAI-003
// Source verification components confer no execution, custody or publication authority.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inflateRawSync } from 'node:zlib';
// Site archive validation is usable on the bare Node documentation runner.
// Scored verification still requires the real schema and canonicalization packages.
let schemaApi: typeof import('@devai-nyx/schemas') | undefined;
let utilsApi: typeof import('@devai-nyx/utils') | undefined;
try {
  schemaApi = await import('@devai-nyx/schemas');
  utilsApi = await import('@devai-nyx/utils');
} catch {
  /* Scored calls refuse missing runtime dependencies below. */
}
const getValidator: typeof import('@devai-nyx/schemas').getValidator = (...args) => {
  demand(schemaApi);
  return schemaApi.getValidator(...args);
};
const extractStructuredReply: typeof import('@devai-nyx/schemas').extractStructuredReply = (
  ...args
) => {
  demand(schemaApi);
  return schemaApi.extractStructuredReply(...args);
};
const canonicalJson: typeof import('@devai-nyx/utils').canonicalJson = (...args) => {
  demand(utilsApi);
  return utilsApi.canonicalJson(...args);
};

export const SOFT_DIMENSIONS = [
  'spec_coherence',
  'plant_idiomaticity',
  'test_depth',
  'traceability_quality',
] as const;
const DOMAIN = 'DEVAI-SOFT-GATE-EVIDENCE-V1\n';
const MiB = 1024 * 1024;
export interface GateFinding {
  readonly code: string;
  readonly invariant_id?: string;
}
export interface GateResult {
  readonly status: 'pass' | 'fail' | 'error' | 'review';
  readonly findings: readonly GateFinding[];
}
const pass = (): GateResult => Object.freeze({ status: 'pass', findings: Object.freeze([]) });
function refusal(code: string, status: GateResult['status'] = 'error'): GateResult {
  return { status, findings: [{ code }] };
}
function demand(value: unknown, code = 'CI_GATE_INVALID_EVIDENCE'): asserts value {
  if (!value) throw new Error(code);
}
export function evidenceSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canon(value: unknown): string {
  return canonicalJson(value as Parameters<typeof canonicalJson>[0]);
}
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
export function containedEvidencePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 512 &&
    path === path.normalize('NFC') &&
    !path.includes(':') &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    path.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  );
}
function bytes(value: unknown): asserts value is Uint8Array {
  demand(value instanceof Uint8Array);
}
export function canonicalEvidenceObject(
  raw: Uint8Array,
  schema: string,
  limit = MiB,
): Record<string, unknown> {
  bytes(raw);
  demand(raw.byteLength <= limit);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const value: unknown = JSON.parse(text);
  demand(getValidator(schema)(value), 'CI_GATE_SCHEMA_INVALID');
  demand(text === canon(value), 'CI_GATE_CANONICAL_BYTES_INVALID');
  return value as Record<string, unknown>;
}
interface Citation {
  path: string;
  location: string;
  source_sha256: string;
}
interface Score {
  schemaVersion: string;
  verdict: string;
  confidence: number;
  rationale: string;
  scores: Record<string, number>;
  citations: Record<string, Citation[]>;
}
interface ScoreInput {
  score: Score;
  thresholds: { soft_gate: Record<string, unknown> };
  thresholdBytes?: Uint8Array;
  rubric: Record<string, unknown>;
  sourceFiles: Map<string, Uint8Array>;
}
export function validateScoredSoftGate(input: unknown): GateResult {
  try {
    demand(input && typeof input === 'object');
    const x = input as ScoreInput;
    demand(getValidator('soft-gate-score.schema.json')(x.score));
    demand(getValidator('thresholds.schema.json')(x.thresholds));
    if (x.thresholdBytes !== undefined) {
      bytes(x.thresholdBytes);
      demand(
        same(
          x.thresholds,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(x.thresholdBytes)),
        ),
      );
    }
    demand(getValidator('soft-gate-rubric.schema.json')(x.rubric));
    const floor = x.thresholds.soft_gate;
    demand(
      floor.scale_min === 0 &&
        floor.scale_max === 4 &&
        floor.aggregation === 'all-dimensions' &&
        floor.max_age_hours === 24 &&
        floor.future_tolerance_seconds === 0 &&
        floor.require_independent_evaluator === true &&
        floor.require_completed_no_tool_mcp === true,
    );
    demand(same(floor.minimum_scores, Object.fromEntries(SOFT_DIMENSIONS.map((d) => [d, 3]))));
    demand(x.sourceFiles instanceof Map);
    for (const d of SOFT_DIMENSIONS) {
      const citations = x.score.citations[d];
      demand(citations && citations.length > 0);
      for (const c of citations) {
        demand(containedEvidencePath(c.path));
        const source = x.sourceFiles.get(c.path);
        bytes(source);
        demand(evidenceSha256(source) === c.source_sha256);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
        const lines = text.replace(/\n$/u, '').split('\n');
        const loc = /^L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/u.exec(c.location);
        if (loc) {
          const start = Number(loc[1]),
            end = Number(loc[2] ?? loc[1]);
          demand(start <= end && end <= lines.length);
        } else {
          const anchor = c.location.slice(1);
          const headings = lines
            .filter((l) => /^#{1,6}\s/u.test(l))
            .map((l) =>
              l
                .replace(/^#{1,6}\s+/u, '')
                .trim()
                .toLowerCase()
                .replace(/[^\p{L}\p{N}_ -]/gu, '')
                .replace(/ /gu, '-'),
            );
          demand(
            c.location.startsWith('#') &&
              (headings.includes(anchor) ||
                text.includes(`id="${anchor}"`) ||
                text.includes(`name="${anchor}"`)),
          );
        }
      }
    }
    if (x.score.verdict === 'unknown') return refusal('CI_GATE_SOFT_UNKNOWN');
    if (SOFT_DIMENSIONS.some((d) => (x.score.scores[d] ?? -1) < 3))
      return refusal('CI_GATE_SOFT_DIMENSION_BELOW_FLOOR', 'fail');
    if (x.score.verdict !== 'pass')
      return refusal(
        'CI_GATE_SOFT_VERDICT_NOT_PASS',
        x.score.verdict === 'review' ? 'review' : 'fail',
      );
    return pass();
  } catch {
    return refusal('CI_GATE_SOFT_EVIDENCE_INVALID');
  }
}
interface Agent {
  agent_id: string;
  session_id: string;
  process_instance_id: string;
  host: 'codex' | 'claude';
  model: string;
}
interface Candidate {
  commit: string;
  tree: string;
  base_commit: string;
}
interface Control {
  commit: string;
  tree: string;
  executable_sha256: string;
}
export interface ExpectedSoftEvidence {
  repository: string;
  evidenceCommit: string;
  candidate: Candidate;
  producerControl: Control;
  workingAgent: Agent;
  boundInputs: Record<string, string>;
}
interface Manifest {
  candidate: Candidate;
  producer_control: Control;
  working_agent: Agent;
  evaluator: Agent;
  repository: string;
  created_at: string;
  bound_inputs: Record<string, string>;
  reply_sha256: string;
  host_envelope_sha256: string;
  score_projection_sha256: string;
  payload_roles: Record<string, string>;
  members: { path: string; byte_length: number; sha256: string }[];
}
interface Trust {
  repository: string;
  evidence_commit: string;
  payload_sha256: string;
  candidate: Candidate;
  producer_control: Control;
  working_agent: Agent;
  evaluator_identity: Agent;
  custodian_id: string;
  public_key_spki_der_base64: string;
  key_id: string;
  selected_at: string;
  expires_at: string;
}
export interface RawSoftEvidence {
  manifestBytes: Uint8Array;
  signature: Uint8Array;
  trustBytes: Uint8Array;
  members: Map<string, Uint8Array>;
  expected: ExpectedSoftEvidence;
  now: string;
  sourceFiles: Map<string, Uint8Array>;
}
interface PayloadSnapshot {
  raw: RawSoftEvidence;
  manifest: Manifest;
  score: Score;
  trust: Trust;
}
const payloads = new WeakMap<object, PayloadSnapshot>();
function independent(a: Agent, b: Agent): boolean {
  return ['agent_id', 'session_id', 'process_instance_id'].every(
    (k) =>
      (a as unknown as Record<string, string>)[k] !== (b as unknown as Record<string, string>)[k],
  );
}
function validTime(trust: Trust, manifest: Manifest, now: string): void {
  const t = Date.parse(now),
    created = Date.parse(manifest.created_at),
    selected = Date.parse(trust.selected_at),
    expires = Date.parse(trust.expires_at);
  demand(
    [t, created, selected, expires].every(Number.isFinite) &&
      created <= selected &&
      selected <= t &&
      created <= t &&
      t - created <= 24 * 60 * 60 * 1000 &&
      expires > t &&
      expires > selected,
  );
}
function cloneMembers(m: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...m].map(([p, b]) => [p, Buffer.from(b)]));
}
export function verifySoftGatePayload(input: unknown): GateResult {
  try {
    demand(input && typeof input === 'object');
    const x = input as RawSoftEvidence;
    const m = canonicalEvidenceObject(
      x.manifestBytes,
      'soft-gate-evidence.schema.json',
    ) as unknown as Manifest;
    const t = canonicalEvidenceObject(
      x.trustBytes,
      'soft-gate-trust.schema.json',
    ) as unknown as Trust;
    demand(
      x.expected &&
        m.repository === x.expected.repository &&
        t.repository === m.repository &&
        t.evidence_commit === x.expected.evidenceCommit,
    );
    demand(evidenceSha256(x.manifestBytes) === t.payload_sha256);
    for (const [actual, trusted, expected] of [
      [m.candidate, t.candidate, x.expected.candidate],
      [m.producer_control, t.producer_control, x.expected.producerControl],
      [m.working_agent, t.working_agent, x.expected.workingAgent],
    ])
      demand(same(actual, trusted) && same(actual, expected));
    demand(
      same(m.bound_inputs, x.expected.boundInputs) &&
        same(m.evaluator, t.evaluator_identity) &&
        independent(m.working_agent, m.evaluator) &&
        t.custodian_id !== m.working_agent.agent_id,
    );
    validTime(t, m, x.now);
    const der = Buffer.from(t.public_key_spki_der_base64, 'base64');
    demand(
      der.toString('base64') === t.public_key_spki_der_base64 && evidenceSha256(der) === t.key_id,
    );
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    demand(
      key.asymmetricKeyType === 'ed25519' && same(key.export({ type: 'spki', format: 'der' }), der),
    );
    bytes(x.signature);
    demand(
      x.signature.length === 64 &&
        verify(
          null,
          Buffer.concat([Buffer.from(DOMAIN), Buffer.from(x.manifestBytes)]),
          key,
          x.signature,
        ),
    );
    demand(
      x.members instanceof Map && m.members.length <= 64 && x.members.size === m.members.length,
    );
    const names = m.members.map((v) => v.path);
    demand(new Set(names).size === names.length && same(names, [...names].sort()));
    let total = 0;
    for (const member of m.members) {
      demand(
        containedEvidencePath(member.path) &&
          !['manifest.json', 'signature.ed25519'].includes(member.path),
      );
      const raw = x.members.get(member.path);
      bytes(raw);
      demand(
        raw.length === member.byte_length &&
          raw.length <= 16 * MiB &&
          evidenceSha256(raw) === member.sha256,
      );
      total += raw.length;
      demand(total <= 32 * MiB);
    }
    const rolePaths = Object.values(m.payload_roles);
    demand(
      new Set(rolePaths).size === rolePaths.length && rolePaths.every((p) => names.includes(p)),
    );
    const member = (role: string): Uint8Array => {
      const p = m.payload_roles[role];
      demand(p);
      const raw = x.members.get(p);
      bytes(raw);
      return raw;
    };
    demand(
      evidenceSha256(member('score_reply')) === m.reply_sha256 &&
        evidenceSha256(member('host_envelope')) === m.host_envelope_sha256,
    );
    for (const [role, bound] of [
      ['effective_rubric', 'rubric_sha256'],
      ['effective_thresholds', 'thresholds_sha256'],
      ['configuration_observation', 'configuration_sha256'],
      ['inventory_observation', 'inventory_sha256'],
      ['host_help_observation', 'host_help_sha256'],
      ['context_inventory', 'context_sha256'],
    ] as const)
      demand(evidenceSha256(member(role)) === m.bound_inputs[bound]);
    const reply = extractStructuredReply(
      {
        text: new TextDecoder('utf-8', { fatal: true }).decode(member('score_reply')),
        finish_reason: 'stop',
      },
      'soft-gate-score.schema.json',
    );
    demand(reply.ok);
    const score = reply.document as unknown as Score;
    demand(evidenceSha256(Buffer.from(canon(score))) === m.score_projection_sha256);
    demand(
      validateScoredSoftGate({
        score,
        thresholds: JSON.parse(Buffer.from(member('effective_thresholds')).toString()),
        thresholdBytes: member('effective_thresholds'),
        rubric: JSON.parse(Buffer.from(member('effective_rubric')).toString()),
        sourceFiles: x.sourceFiles,
      }).status === 'pass',
    );
    const result = pass();
    payloads.set(result, {
      manifest: m,
      score,
      trust: t,
      raw: {
        ...x,
        manifestBytes: Buffer.from(x.manifestBytes),
        signature: Buffer.from(x.signature),
        trustBytes: Buffer.from(x.trustBytes),
        members: cloneMembers(x.members),
        sourceFiles: cloneMembers(x.sourceFiles),
        expected: structuredClone(x.expected),
      },
    });
    return result;
  } catch {
    return refusal('CI_GATE_PAYLOAD_INVALID');
  }
}
interface PayloadCustody {
  verifiedPayload: object;
  trustBytes: Uint8Array;
  members: Map<string, Uint8Array>;
  expected: ExpectedSoftEvidence;
  now: string;
}
export function consumeVerifiedSoftGatePayload(input: unknown): GateResult {
  try {
    const x = input as PayloadCustody;
    demand(x && typeof x.verifiedPayload === 'object');
    const snapshot = payloads.get(x.verifiedPayload);
    demand(snapshot);
    demand(
      same(Buffer.from(x.trustBytes), Buffer.from(snapshot.raw.trustBytes)) &&
        same(x.expected, snapshot.raw.expected) &&
        same(x.members, snapshot.raw.members),
    );
    validTime(snapshot.trust, snapshot.manifest, x.now);
    return pass();
  } catch {
    return refusal('CI_GATE_PAYLOAD_CUSTODY_CHANGED');
  }
}
export interface HostObservation {
  workingAgent: Agent;
  evaluator: Agent;
  executable: { path: string; bytes: Uint8Array };
  version: { status: number; stdout: Uint8Array };
  hostHelp: { status: number; stdout: Uint8Array };
  configuration: {
    tools: unknown[];
    mcp_servers: unknown[];
    hooks: unknown[];
    plugins: unknown[];
    agents: unknown[];
    inheritedConversation: boolean;
    precedence: { source: string; sha256: string }[];
  };
  configurationBytes: Uint8Array;
  selectedControls: {
    executablePath: string;
    executableSha256: string;
    version: string;
    hostHelpSha256: string;
    configurationSha256: string;
    argvSha256: string;
  };
  invocation: {
    process_instance_id: string;
    argv: string[];
    status: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  };
}
interface HostSnapshot {
  input: HostObservation;
  replyBytes: Uint8Array;
}
const hosts = new WeakMap<object, HostSnapshot>();
function obj(v: unknown): Record<string, unknown> {
  demand(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
}
function unsafeHost(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(unsafeHost);
  if (!v || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  if (
    typeof n.type === 'string' &&
    /tool|mcp|command_execution|refusal|error|failed/iu.test(n.type)
  )
    return true;
  if (
    n.is_error === true ||
    n.error != null ||
    n.function_call != null ||
    (n.refusal != null && n.refusal !== '') ||
    (n.tool_calls !== undefined && (!Array.isArray(n.tool_calls) || n.tool_calls.length !== 0))
  )
    return true;
  if (n.status !== undefined && !['in_progress', 'completed', 'success'].includes(String(n.status)))
    return true;
  for (const k of ['tools', 'mcp_servers'])
    if (n[k] !== undefined && (!Array.isArray(n[k]) || n[k].length !== 0)) return true;
  return Object.values(n).some(unsafeHost);
}
/** Pure interpretation of the retained native stream; selected reply text is data. */
export function inspectSoftGateHostStream(
  raw: Uint8Array,
  host: 'codex' | 'claude',
): { replyBytes: Uint8Array; tools: readonly unknown[]; mcp_servers: readonly unknown[] } {
  bytes(raw);
  demand(raw.length > 0 && raw.length <= 32 * MiB);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  let values: unknown[];
  try {
    values = [JSON.parse(text) as unknown];
  } catch {
    values = text
      .split('\n')
      .filter((l) => l.trim().length)
      .map((l) => JSON.parse(l) as unknown);
  }
  const events = values.map(obj);
  demand(events.length > 0);
  const inventory = events.filter((e) => Array.isArray(e.tools) && Array.isArray(e.mcp_servers));
  const observedInventory = inventory[0];
  demand(inventory.length === 1 && observedInventory);
  demand(
    Array.isArray(observedInventory.tools) &&
      observedInventory.tools.length === 0 &&
      Array.isArray(observedInventory.mcp_servers) &&
      observedInventory.mcp_servers.length === 0,
  );
  const ids = new Map<string, string>(),
    items = new Map<string, { type: string; open: boolean }>();
  let completed = 0;
  let starts = 0;
  const replies: string[] = [];
  function identity(k: string, v: unknown) {
    if (v === undefined) return;
    demand(typeof v === 'string' && v.length > 0 && (!ids.has(k) || ids.get(k) === v));
    ids.set(k, v);
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    demand(e);
    demand(!unsafeHost(e));
    for (const k of ['session', 'thread', 'turn']) {
      identity(k, e[`${k}_id`]);
      const n = e[k];
      if (n !== undefined) identity(k, obj(n).id);
    }
    if (host === 'codex') {
      demand(
        [
          'thread.started',
          'turn.started',
          'item.started',
          'item.updated',
          'item.completed',
          'turn.completed',
        ].includes(String(e.type)) && completed === 0,
      );
      if (e.type === 'thread.started') {
        demand(i === 0 && starts++ === 0);
        identity('thread', e.id);
      }
      if (e.type === 'turn.started') {
        demand(!replies.length && !items.size);
        identity('turn', e.id);
      }
      if (String(e.type).startsWith('item.')) {
        const item = obj(e.item);
        const type = String(item.type);
        demand(['agent_message', 'reasoning'].includes(type));
        for (const k of ['session', 'thread', 'turn']) identity(k, item[`${k}_id`]);
        const done = e.type === 'item.completed';
        demand(e.status === undefined || e.status === (done ? 'completed' : 'in_progress'));
        demand(item.status === undefined || item.status === (done ? 'completed' : 'in_progress'));
        demand(
          typeof item.id === 'string' &&
            item.id.length > 0 &&
            (e.item_id === undefined || e.item_id === item.id),
        );
        const prior = items.get(item.id);
        demand(!prior || (prior.type === type && prior.open && e.type !== 'item.started'));
        items.set(item.id, { type, open: !done });
        if (done && type === 'agent_message') {
          demand(typeof item.text === 'string');
          replies.push(item.text);
        }
      }
      if (e.type === 'turn.completed') {
        demand(
          i === events.length - 1 &&
            replies.length === 1 &&
            [...items.values()].every((v) => !v.open) &&
            (e.finish_reason === undefined || e.finish_reason === 'stop') &&
            (e.terminal_reason === undefined || e.terminal_reason === 'completed') &&
            (e.status === undefined || e.status === 'completed'),
        );
        completed++;
      }
    } else {
      demand(['system', 'assistant', 'result'].includes(String(e.type)));
      if (e.type === 'system') demand(i === 0 && e.subtype === 'init');
      if (e.type === 'assistant') {
        const m = obj(e.message);
        demand(
          Array.isArray(m.content) &&
            m.content.every((v) =>
              ['text', 'thinking', 'redacted_thinking'].includes(String(obj(v).type)),
            ),
        );
      }
      if (e.type === 'result') {
        demand(
          i === events.length - 1 &&
            completed++ === 0 &&
            e.subtype === 'success' &&
            e.is_error === false &&
            ['end_turn', 'stop_sequence', 'tool_use'].includes(String(e.stop_reason)),
        );
        if (e.stop_reason === 'tool_use')
          demand(
            e.terminal_reason === 'completed' &&
              e.structured_output &&
              typeof e.structured_output === 'object',
          );
        demand(e.terminal_reason === undefined || e.terminal_reason === 'completed');
        const reply =
          e.structured_output === undefined ? e.result : JSON.stringify(e.structured_output);
        demand(typeof reply === 'string' && reply.length > 0);
        replies.push(reply);
      }
    }
  }
  demand(completed === 1 && replies.length === 1);
  const selectedReply = replies[0];
  demand(typeof selectedReply === 'string');
  return { replyBytes: Buffer.from(selectedReply), tools: [], mcp_servers: [] };
}
export function verifySoftGateHostObservation(input: unknown): GateResult {
  try {
    const x = input as HostObservation;
    demand(x && independent(x.workingAgent, x.evaluator));
    demand(
      ['codex', 'claude'].includes(x.evaluator.host) &&
        x.invocation.process_instance_id === x.evaluator.process_instance_id,
    );
    bytes(x.executable.bytes);
    bytes(x.configurationBytes);
    bytes(x.hostHelp.stdout);
    bytes(x.version.stdout);
    bytes(x.invocation.stderr);
    demand(
      x.executable.path === x.selectedControls.executablePath &&
        evidenceSha256(x.executable.bytes) === x.selectedControls.executableSha256 &&
        x.version.status === 0 &&
        x.hostHelp.status === 0 &&
        Buffer.from(x.version.stdout).toString().trim() === x.selectedControls.version &&
        evidenceSha256(x.hostHelp.stdout) === x.selectedControls.hostHelpSha256 &&
        evidenceSha256(x.configurationBytes) === x.selectedControls.configurationSha256,
    );
    demand(same(JSON.parse(Buffer.from(x.configurationBytes).toString()), x.configuration));
    for (const k of ['tools', 'mcp_servers', 'hooks', 'plugins', 'agents'] as const)
      demand(Array.isArray(x.configuration[k]) && x.configuration[k].length === 0);
    demand(
      x.configuration.inheritedConversation === false &&
        Array.isArray(x.configuration.precedence) &&
        x.configuration.precedence.length > 0 &&
        x.configuration.precedence.every(
          (p) => p.source.length > 0 && /^[a-f0-9]{64}$/u.test(p.sha256),
        ),
    );
    demand(
      x.invocation.status === 0 &&
        x.invocation.stderr.length === 0 &&
        Array.isArray(x.invocation.argv) &&
        x.invocation.argv.every((v) => typeof v === 'string') &&
        evidenceSha256(Buffer.from(JSON.stringify(x.invocation.argv))) ===
          x.selectedControls.argvSha256,
    );
    const argv = x.invocation.argv,
      help = Buffer.from(x.hostHelp.stdout).toString();
    if (x.evaluator.host === 'codex') {
      demand(
        argv[0] === 'exec' &&
          argv.includes('--json') &&
          argv.includes('--ephemeral') &&
          argv[argv.indexOf('--sandbox') + 1] === 'read-only',
      );
      demand(
        argv.some((v, i) => v === '--config' && argv[i + 1] === 'mcp_servers={}') &&
          argv.some((v, i) => v === '--config' && argv[i + 1] === 'tools={}'),
      );
      for (const flag of ['--json', '--ephemeral', '--sandbox', '--config'])
        demand(help.includes(flag));
    } else {
      for (const flag of [
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        '--tools',
        '--setting-sources',
      ])
        demand(argv.includes(flag) && help.includes(flag));
      demand(
        argv[argv.indexOf('--tools') + 1] === '' &&
          argv[argv.indexOf('--setting-sources') + 1] === '' &&
          argv[argv.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}',
      );
    }
    const stream = inspectSoftGateHostStream(x.invocation.stdout, x.evaluator.host);
    const result = pass();
    hosts.set(result, { input: structuredClone(x), replyBytes: Buffer.from(stream.replyBytes) });
    return result;
  } catch {
    return refusal('CI_GATE_HOST_OBSERVATION_INVALID');
  }
}
interface CiGateInput {
  invariants: { id: string; severity: string }[];
  traceEntries: { invariant_id: string; tests: string[] }[];
  hardVerdicts: { invariant_id: string; status: string }[];
  candidate: Candidate;
  producerControl: Control;
  workingAgent: Agent;
  boundInputs: Record<string, string>;
  verifiedSoftEvidence: object;
  verifiedHostObservation: object;
  softEvidenceCustody: PayloadCustody;
  hostObservation: HostObservation;
  scoreInput: ScoreInput;
  testFiles: Map<string, Uint8Array>;
  trackedTestPaths: string[];
}
export function evaluateCiInvariantGate(input: unknown): GateResult {
  const findings: GateFinding[] = [];
  const add = (code: string, invariant_id?: string) =>
    findings.push({ code, ...(invariant_id === undefined ? {} : { invariant_id }) });
  try {
    const x = input as CiGateInput;
    demand(
      x &&
        Array.isArray(x.invariants) &&
        Array.isArray(x.traceEntries) &&
        Array.isArray(x.hardVerdicts),
    );
    if (!x.invariants.length) add('CI_GATE_INVARIANT_POPULATION_EMPTY');
    if (!x.traceEntries.length) add('CI_GATE_TRACE_POPULATION_EMPTY');
    const ids = x.invariants.map((v) => v.id);
    demand(
      new Set(ids).size === ids.length && ids.every((id) => /^INV-[A-Z0-9]+-[0-9]+$/u.test(id)),
    );
    const traces = new Map<string, { invariant_id: string; tests: string[] }>();
    for (const trace of x.traceEntries) {
      if (!ids.includes(trace.invariant_id))
        add('CI_GATE_TRACE_UNKNOWN_INVARIANT', trace.invariant_id);
      demand(!traces.has(trace.invariant_id));
      traces.set(trace.invariant_id, trace);
      demand(
        Array.isArray(trace.tests) &&
          trace.tests.length > 0 &&
          new Set(trace.tests).size === trace.tests.length,
      );
      for (const path of trace.tests) {
        demand(containedEvidencePath(path) && x.trackedTestPaths.includes(path));
        const b = x.testFiles.get(path);
        bytes(b);
        const text = Buffer.from(b).toString();
        demand(
          text.includes(trace.invariant_id) &&
            /\b(?:it|test)\s*(?:\.\w+)*\s*\(/u.test(text) &&
            /\bexpect\s*\(/u.test(text),
        );
      }
    }
    const roster = new Map<string, string>();
    for (const verdict of x.hardVerdicts) {
      demand(ids.includes(verdict.invariant_id) && !roster.has(verdict.invariant_id));
      roster.set(verdict.invariant_id, verdict.status);
    }
    for (const inv of x.invariants.filter((v) =>
      ['constitutional', 'hard-fail', 'gate'].includes(v.severity),
    )) {
      if (!traces.has(inv.id)) add('CI_GATE_TRACE_INVARIANT_MISSING', inv.id);
      if (inv.id !== 'INV-HARNESS-006') {
        if (!roster.has(inv.id)) add('CI_GATE_HARD_EVIDENCE_MISSING', inv.id);
        else if (roster.get(inv.id) !== 'pass') add('CI_GATE_HARD_VERDICT_NOT_PASS', inv.id);
      }
    }
    const p = payloads.get(x.verifiedSoftEvidence),
      h = hosts.get(x.verifiedHostObservation);
    demand(p && h);
    demand(
      x.softEvidenceCustody.verifiedPayload === x.verifiedSoftEvidence &&
        consumeVerifiedSoftGatePayload(x.softEvidenceCustody).status === 'pass',
    );
    demand(
      same(x.candidate, p.manifest.candidate) &&
        same(x.producerControl, p.manifest.producer_control) &&
        same(x.workingAgent, p.manifest.working_agent) &&
        same(x.boundInputs, p.manifest.bound_inputs),
    );
    demand(
      same(structuredClone(x.hostObservation), h.input) &&
        verifySoftGateHostObservation(x.hostObservation).status === 'pass',
    );
    const roles = p.manifest.payload_roles;
    const raw = (role: string) => {
      const path = roles[role];
      demand(path);
      const b = p.raw.members.get(path);
      bytes(b);
      return b;
    };
    demand(
      same(Buffer.from(h.replyBytes), Buffer.from(raw('score_reply'))) &&
        same(Buffer.from(x.hostObservation.invocation.stdout), Buffer.from(raw('host_envelope'))) &&
        same(
          Buffer.from(x.hostObservation.configurationBytes),
          Buffer.from(raw('configuration_observation')),
        ) &&
        same(
          Buffer.from(x.hostObservation.hostHelp.stdout),
          Buffer.from(raw('host_help_observation')),
        ),
    );
    demand(
      same(x.hostObservation.workingAgent, p.manifest.working_agent) &&
        same(x.hostObservation.evaluator, p.manifest.evaluator) &&
        evidenceSha256(x.hostObservation.executable.bytes) ===
          p.manifest.producer_control.executable_sha256,
    );
    const control = obj(JSON.parse(Buffer.from(raw('control_observation')).toString()));
    demand(
      same(control, { ...p.manifest.producer_control, ...x.hostObservation.selectedControls }),
    );
    const envelope = obj(JSON.parse(Buffer.from(raw('invocation_envelope')).toString()));
    demand(
      same(envelope, {
        process_instance_id: x.hostObservation.invocation.process_instance_id,
        argv: x.hostObservation.invocation.argv,
        status: x.hostObservation.invocation.status,
        stdout_sha256: evidenceSha256(x.hostObservation.invocation.stdout),
        stderr_sha256: evidenceSha256(x.hostObservation.invocation.stderr),
      }),
    );
    demand(
      same(JSON.parse(Buffer.from(raw('inventory_observation')).toString()), {
        tools: [],
        mcp_servers: [],
        hooks: [],
        plugins: [],
        agents: [],
      }) &&
        same(JSON.parse(Buffer.from(raw('context_inventory')).toString()), {
          inheritedConversation: false,
          messages: [],
          agents: [],
        }),
    );
    demand(evidenceSha256(raw('effective_thresholds')) === x.boundInputs.thresholds_sha256);
    if (x.scoreInput.thresholdBytes !== undefined) {
      bytes(x.scoreInput.thresholdBytes);
      demand(
        same(Buffer.from(x.scoreInput.thresholdBytes), Buffer.from(raw('effective_thresholds'))),
      );
    }
    demand(
      same(x.scoreInput.score, p.score) &&
        same(x.scoreInput.rubric, JSON.parse(Buffer.from(raw('effective_rubric')).toString())) &&
        same(
          x.scoreInput.thresholds,
          JSON.parse(Buffer.from(raw('effective_thresholds')).toString()),
        ) &&
        same(x.scoreInput.sourceFiles, p.raw.sourceFiles) &&
        validateScoredSoftGate(x.scoreInput).status === 'pass',
    );
    demand(
      evidenceSha256(
        Buffer.from(
          canon(
            [...x.scoreInput.sourceFiles].map(([path, b]) => ({
              path,
              byte_length: b.length,
              sha256: evidenceSha256(b),
            })),
          ),
        ),
      ) === x.boundInputs.source_population_sha256,
    );
    demand(evidenceSha256(Buffer.from(canon(x.hardVerdicts))) === x.boundInputs.task_roster_sha256);
    for (const [path, b] of x.testFiles)
      demand(same(Buffer.from(b), Buffer.from(p.raw.sourceFiles.get(path) ?? [])));
    if (findings.length) return { status: 'fail', findings };
    return pass();
  } catch {
    add('CI_GATE_AUTHENTIC_EVIDENCE_REQUIRED');
    return { status: 'error', findings };
  }
}
interface SiteMember {
  path: string;
  size: number;
  sha256: string;
}
interface SiteInput {
  archiveBytes: Uint8Array;
  artifact: {
    id: string;
    runId: string;
    sourceCommit: string;
    sourceTree: string;
    archiveSha256: string;
    siteSha256: string;
    members: SiteMember[];
  };
  expected: {
    artifactId: string;
    runId: string;
    sourceCommit: string;
    sourceTree: string;
    siteSha256: string;
    preparationConclusion: string;
  };
}
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) {
    c ^= v;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** Validate the entire single-member ZIP before bounded decompression. */
function pagesTar(raw: Uint8Array): Buffer {
  const b = Buffer.from(raw);
  demand(b.length >= 22 && b.length <= 544 * MiB);
  const e = b.length - 22;
  demand(
    b.readUInt32LE(e) === 0x06054b50 &&
      b.readUInt16LE(e + 4) === 0 &&
      b.readUInt16LE(e + 6) === 0 &&
      b.readUInt16LE(e + 8) === 1 &&
      b.readUInt16LE(e + 10) === 1 &&
      b.readUInt16LE(e + 20) === 0,
  );
  const c = b.readUInt32LE(e + 16),
    cl = b.readUInt32LE(e + 12);
  demand(c + cl === e && cl >= 46 && b.readUInt32LE(c) === 0x02014b50);
  const flags = b.readUInt16LE(c + 8),
    method = b.readUInt16LE(c + 10),
    crc = b.readUInt32LE(c + 16),
    packed = b.readUInt32LE(c + 20),
    expanded = b.readUInt32LE(c + 24),
    nl = b.readUInt16LE(c + 28),
    extra = b.readUInt16LE(c + 30),
    comment = b.readUInt16LE(c + 32);
  demand(
    (flags === 0 || flags === 8 || flags === 0x800 || flags === (8 | 0x800)) &&
      (method === 0 || method === 8) &&
      expanded <= 544 * MiB &&
      packed <= 544 * MiB &&
      extra === 0 &&
      comment === 0 &&
      cl === 46 + nl &&
      b.readUInt16LE(c + 34) === 0 &&
      b.readUInt32LE(c + 42) === 0,
  );
  const mode = b.readUInt32LE(c + 38) >>> 16;
  demand(mode === 0 || mode === 0o100644 || mode === 0o100664);
  const name = b.subarray(c + 46, c + 46 + nl);
  demand(name.toString() === 'artifact.tar');
  demand(
    b.readUInt32LE(0) === 0x04034b50 &&
      b.readUInt16LE(6) === flags &&
      b.readUInt16LE(8) === method &&
      b.readUInt16LE(26) === nl &&
      b.readUInt16LE(28) === 0 &&
      same(b.subarray(30, 30 + nl), name),
  );
  const start = 30 + nl,
    end = start + packed;
  demand(end <= c);
  if (flags & 8) {
    demand(
      end + 16 === c &&
        b.readUInt32LE(end) === 0x08074b50 &&
        b.readUInt32LE(end + 4) === crc &&
        b.readUInt32LE(end + 8) === packed &&
        b.readUInt32LE(end + 12) === expanded &&
        b.readUInt32LE(14) === 0 &&
        b.readUInt32LE(18) === 0 &&
        b.readUInt32LE(22) === 0,
    );
  } else
    demand(
      end === c &&
        b.readUInt32LE(14) === crc &&
        b.readUInt32LE(18) === packed &&
        b.readUInt32LE(22) === expanded,
    );
  const compressed = b.subarray(start, end);
  let result: Buffer;
  if (method === 0) {
    demand(packed === expanded);
    result = Buffer.from(compressed);
  } else {
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: 544 * MiB,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    demand(inflated.engine.bytesWritten === packed);
    result = inflated.buffer;
  }
  demand(result.length === expanded && crc32(result) === crc);
  return result;
}
interface TarFile {
  path: string;
  bytes: Uint8Array;
}
function tarFiles(b: Buffer): TarFile[] {
  demand(b.length >= 1024 && b.length % 512 === 0);
  const files: TarFile[] = [];
  const paths = new Set<string>();
  let offset = 0,
    longName: string | undefined;
  function field(h: Buffer, start: number, size: number): string {
    const v = h.subarray(start, start + size),
      nul = v.indexOf(0);
    if (nul < 0) return new TextDecoder('utf-8', { fatal: true }).decode(v);
    demand(v.subarray(nul).every((n) => n === 0));
    return new TextDecoder('utf-8', { fatal: true }).decode(v.subarray(0, nul));
  }
  function octal(h: Buffer, start: number, size: number): number {
    const v = h
      .subarray(start, start + size)
      .toString()
      .replace(/[\0 ]+$/u, '')
      .trim();
    demand(/^[0-7]+$/u.test(v));
    const n = parseInt(v, 8);
    demand(Number.isSafeInteger(n));
    return n;
  }
  while (offset + 512 <= b.length) {
    const h = b.subarray(offset, offset + 512);
    if (h.every((n) => n === 0)) {
      demand(
        longName === undefined &&
          offset + 1024 <= b.length &&
          b.subarray(offset).every((n) => n === 0),
      );
      break;
    }
    const stored = octal(h, 148, 8);
    const checksum = h.reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0);
    demand(checksum === stored);
    demand(['ustar ', 'ustar\0'].includes(h.subarray(257, 263).toString()));
    const size = octal(h, 124, 12);
    demand(size <= 64 * MiB);
    const type = String.fromCharCode(h[156] ?? 0);
    const link = field(h, 157, 100);
    demand(link === '');
    let path = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    if (prefix) path = `${prefix}/${path}`;
    const start = offset + 512,
      end = start + size,
      padded = start + Math.ceil(size / 512) * 512;
    demand(padded <= b.length && b.subarray(end, padded).every((n) => n === 0));
    offset = padded;
    if (type === 'L') {
      demand(
        longName === undefined &&
          path === '././@LongLink' &&
          size > 1 &&
          size <= 513 &&
          b[end - 1] === 0,
      );
      longName = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start, end - 1));
      demand(!longName.includes('\0'));
      continue;
    }
    demand(['0', '\0', '5'].includes(type));
    if (longName !== undefined) {
      demand(type !== '5' && longName.slice(0, 100) === path);
      path = longName;
      longName = undefined;
    }
    if (path === './' && type === '5') {
      demand(size === 0 && !paths.has(''));
      paths.add('');
      continue;
    }
    if (path.startsWith('./')) path = path.slice(2);
    if (type === '5' && path.endsWith('/')) path = path.slice(0, -1);
    demand(
      containedEvidencePath(path) &&
        path.split('/').every((p) => !p.startsWith('.')) &&
        !paths.has(path),
    );
    paths.add(path);
    demand(paths.size <= 40000);
    if (type === '5') demand(size === 0);
    else files.push({ path, bytes: Buffer.from(b.subarray(start, end)) });
  }
  demand(
    offset <= b.length - 1024 && files.length > 0 && files.some((f) => f.path === 'index.html'),
  );
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++)
      demand(!files.some((v) => v.path === parts.slice(0, i).join('/')));
  }
  return files;
}
const sites = new WeakMap<object, readonly TarFile[]>();
function orderedSiteMembers(files: readonly TarFile[]): SiteMember[] {
  return files
    .map((f) => ({ path: f.path, size: f.bytes.length, sha256: evidenceSha256(f.bytes) }))
    .sort((a, b) => {
      // Match siteMembers' depth-first traversal of default-sorted sibling names.
      const left = a.path.split('/'),
        right = b.path.split('/');
      for (const [index, segment] of left.entries()) {
        const other = right[index];
        if (other === undefined) return 1;
        if (segment < other) return -1;
        if (segment > other) return 1;
      }
      return left.length - right.length;
    });
}
/**
 * The bounded member population carried by a Pages archive itself. It is not authority on its
 * own: validateSitePreparationArtifact still binds it to the read-only preparation siteSha256.
 */
export function siteArchiveMembers(raw: Uint8Array): readonly SiteMember[] {
  bytes(raw);
  const files = tarFiles(pagesTar(raw));
  demand(
    files.length <= 20000 && files.reduce((sum, file) => sum + file.bytes.length, 0) <= 512 * MiB,
  );
  return orderedSiteMembers(files);
}
export function validateSitePreparationArtifact(
  input: unknown,
): GateResult & { readonly members?: readonly SiteMember[] } {
  try {
    const x = input as SiteInput;
    demand(x && x.artifact && x.expected);
    bytes(x.archiveBytes);
    const a = x.artifact,
      e = x.expected;
    demand(
      /^[1-9][0-9]*$/u.test(a.id) &&
        /^[1-9][0-9]*$/u.test(a.runId) &&
        /^[a-f0-9]{40}$/u.test(a.sourceCommit) &&
        /^[a-f0-9]{40}$/u.test(a.sourceTree) &&
        /^[a-f0-9]{64}$/u.test(a.siteSha256),
    );
    demand(
      e.preparationConclusion === 'success' &&
        a.id === e.artifactId &&
        a.runId === e.runId &&
        a.sourceCommit === e.sourceCommit &&
        a.sourceTree === e.sourceTree &&
        a.siteSha256 === e.siteSha256 &&
        evidenceSha256(x.archiveBytes) === a.archiveSha256,
    );
    const files = tarFiles(pagesTar(x.archiveBytes));
    demand(
      files.length <= 20000 && files.reduce((sum, file) => sum + file.bytes.length, 0) <= 512 * MiB,
    );
    const members = orderedSiteMembers(files);
    demand(
      same(members, a.members) &&
        evidenceSha256(Buffer.from(JSON.stringify(members))) === a.siteSha256,
    );
    const result = Object.freeze({ ...pass(), members: Object.freeze(members) });
    sites.set(result, files);
    return result;
  } catch {
    return refusal('CI_GATE_SITE_ARTIFACT_INVALID');
  }
}
/** Only validated file bytes are available for a wrapper's contained extraction. */
export function consumeSitePreparationFiles(result: object): readonly TarFile[] {
  const files = sites.get(result);
  demand(files);
  return files.map((f) => ({ path: f.path, bytes: Buffer.from(f.bytes) }));
}
