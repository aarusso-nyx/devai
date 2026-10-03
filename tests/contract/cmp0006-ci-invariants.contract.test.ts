// Invariants: INV-CORE-003, INV-HARNESS-006, INV-DEVAI-002, INV-DEVAI-003
// Article18 / ADR-MDL-0004. Every negative starts from an accepted complete gate.
// Signed, completed host bytes below are offline verifier controls, never live custody.
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../packages/utils/src/index.js';
const offlineGuard = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const attempts: string[] = [];
  const retained: { object: object; key: string; descriptor: PropertyDescriptor | undefined }[] =
    [];
  const deny = (surface: string): never => {
    attempts.push(surface);
    throw new Error(`OFFLINE_TEST_EFFECT_FORBIDDEN:${surface}`);
  };
  const block = (object: object, key: string, surface: string) => {
    retained.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key) });
    Object.defineProperty(object, key, {
      configurable: true,
      writable: true,
      value: () => deny(surface),
    });
  };
  block(globalThis, 'fetch', 'fetch');
  for (const [object, name] of [
    [http, 'http'],
    [https, 'https'],
  ] as const) {
    block(object, 'request', `${name}.request`);
    block(object, 'get', `${name}.get`);
  }
  block(net.Socket.prototype, 'connect', 'socket.connect');
  block(tls, 'connect', 'tls.connect');
  for (const key of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ]) {
    block(childProcess, key, `child_process.${key}`);
  }
  block(childProcess.ChildProcess.prototype, 'spawn', 'ChildProcess.spawn');
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const { object, key, descriptor } of retained.reverse()) {
        if (descriptor === undefined) Reflect.deleteProperty(object, key);
        else Object.defineProperty(object, key, descriptor);
      }
      syncBuiltinESMExports();
    },
  };
});

afterEach(() => {
  // Surface names only: never print SDK headers, credentials or request bodies.
  expect(offlineGuard.attempts).toEqual([]);
});
afterAll(() => {
  offlineGuard.restore();
  expect(offlineGuard.attempts).toEqual([]);
});

const ROOT = resolve(import.meta.dirname, '../..');
const DOMAIN = 'DEVAI-SOFT-GATE-EVIDENCE-V1\n';
const NOW = '2026-10-02T10:00:00.000Z';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown) => Buffer.from(canonicalJson(value as never));
const dimensions = ['spec_coherence', 'plant_idiomaticity', 'test_depth', 'traceability_quality'];
const roles = [
  'score_reply',
  'host_envelope',
  'configuration_observation',
  'inventory_observation',
  'host_help_observation',
  'context_inventory',
  'effective_rubric',
  'effective_thresholds',
  'control_observation',
  'invocation_envelope',
];
const TEST_PATH = 'tests/contract/cmp0006-ci-invariants.contract.test.ts';
type Agent = {
  agent_id: string;
  session_id: string;
  process_instance_id: string;
  host: string;
  model: string;
};
function hostObservation(reply: Buffer, workingAgent: Agent, evaluator: Agent) {
  const executableBytes = Buffer.from('offline immutable executable fixture; never executed');
  const helpBytes = Buffer.from(
    'Usage: codex exec [OPTIONS]\n--json --ephemeral --sandbox --config\n',
  );
  const configuration = {
    tools: [],
    mcp_servers: [],
    hooks: [],
    plugins: [],
    agents: [],
    inheritedConversation: false,
    precedence: [{ source: 'isolated-settings', sha256: hash(Buffer.from('{}')) }],
  };
  const configurationBytes = Buffer.from(JSON.stringify(configuration));
  const argv = [
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--config',
    'mcp_servers={}',
    '--config',
    'tools={}',
  ];
  const events = [
    { type: 'thread.started', tools: [], mcp_servers: [] },
    {
      type: 'item.completed',
      item: { id: 'final', type: 'agent_message', text: reply.toString('utf8') },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  return {
    workingAgent,
    evaluator,
    executable: { path: '/offline/codex', bytes: executableBytes },
    version: { status: 0, stdout: Buffer.from('codex offline-fixture-version\n') },
    hostHelp: { status: 0, stdout: helpBytes },
    configuration,
    configurationBytes,
    selectedControls: {
      executablePath: '/offline/codex',
      executableSha256: hash(executableBytes),
      version: 'codex offline-fixture-version',
      hostHelpSha256: hash(helpBytes),
      configurationSha256: hash(configurationBytes),
      argvSha256: hash(Buffer.from(JSON.stringify(argv))),
    },
    invocation: {
      process_instance_id: evaluator.process_instance_id,
      argv,
      status: 0,
      stdout: Buffer.from(events.map((event) => JSON.stringify(event)).join('\n')),
      stderr: Buffer.alloc(0),
    },
  };
}
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
  const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), base_commit: 'c'.repeat(40) };
  const working_agent = {
    agent_id: 'worker',
    session_id: 'working-session',
    process_instance_id: 'working-process',
    host: 'codex',
    model: 'offline',
  };
  const evaluator = {
    agent_id: 'evaluator',
    session_id: 'evaluation-session',
    process_instance_id: 'evaluation-process',
    host: 'codex',
    model: 'offline',
  };
  const source = Buffer.from('# Frozen source\nObserved offline criterion.\n');
  const score = {
    schemaVersion: '1.0.0',
    verdict: 'pass',
    confidence: 1,
    rationale: 'Offline payload component.',
    scores: Object.fromEntries(dimensions.map((d) => [d, 3])),
    citations: Object.fromEntries(
      dimensions.map((d) => [
        d,
        [{ path: 'law/reference.md', location: 'L2', source_sha256: hash(source) }],
      ]),
    ),
  };
  const payloadRoles = Object.fromEntries(roles.map((role) => [role, `${role}.json`]));
  const members = new Map<string, Buffer>();
  const reply = Buffer.from(`Selected fixture.\n\`\`\`json\n${JSON.stringify(score)}\n\`\`\``);
  const host = hostObservation(reply, working_agent, evaluator);
  const producer_control = {
    commit: 'd'.repeat(40),
    tree: 'e'.repeat(40),
    executable_sha256: hash(host.executable.bytes),
  };
  const roleBytes: Record<string, Buffer> = {
    score_reply: reply,
    host_envelope: host.invocation.stdout,
    configuration_observation: host.configurationBytes,
    inventory_observation: canonical({
      tools: [],
      mcp_servers: [],
      hooks: [],
      plugins: [],
      agents: [],
    }),
    host_help_observation: host.hostHelp.stdout,
    context_inventory: canonical({ inheritedConversation: false, messages: [], agents: [] }),
    control_observation: canonical({ ...producer_control, ...host.selectedControls }),
    invocation_envelope: canonical({
      process_instance_id: host.invocation.process_instance_id,
      argv: host.invocation.argv,
      status: host.invocation.status,
      stdout_sha256: hash(host.invocation.stdout),
      stderr_sha256: hash(host.invocation.stderr),
    }),
  };
  for (const [role, bytes] of Object.entries(roleBytes))
    members.set(required(payloadRoles[role]), bytes);
  members.set(
    required(payloadRoles.effective_rubric),
    canonical(JSON.parse(readFileSync(resolve(ROOT, 'law/policy/soft-gate-rubric.json'), 'utf8'))),
  );
  members.set(
    required(payloadRoles.effective_thresholds),
    canonical(JSON.parse(readFileSync(resolve(ROOT, 'law/policy/thresholds.json'), 'utf8'))),
  );
  const bound_inputs = Object.fromEntries(
    [
      'source_population_sha256',
      'lockfile_population_sha256',
      'toolchain_sha256',
      'task_roster_sha256',
      'context_sha256',
      'rubric_sha256',
      'thresholds_sha256',
      'configuration_sha256',
      'inventory_sha256',
      'host_help_sha256',
    ].map((name) => [name, hash(Buffer.from(name))]),
  );
  const sourceFiles = new Map([
    ['law/reference.md', source],
    [TEST_PATH, readFileSync(resolve(ROOT, TEST_PATH))],
  ]);
  bound_inputs.source_population_sha256 = hash(
    canonical(
      [...sourceFiles].map(([path, bytes]) => ({
        path,
        byte_length: bytes.length,
        sha256: hash(bytes),
      })),
    ),
  );
  bound_inputs.lockfile_population_sha256 = hash(readFileSync(resolve(ROOT, 'pnpm-lock.yaml')));
  bound_inputs.task_roster_sha256 = hash(
    canonical([{ invariant_id: 'INV-CORE-003', status: 'pass' }]),
  );
  bound_inputs.toolchain_sha256 = hash(host.executable.bytes);
  bound_inputs.rubric_sha256 = hash(required(members.get(required(payloadRoles.effective_rubric))));
  bound_inputs.thresholds_sha256 = hash(
    required(members.get(required(payloadRoles.effective_thresholds))),
  );
  bound_inputs.configuration_sha256 = hash(
    required(members.get(required(payloadRoles.configuration_observation))),
  );
  bound_inputs.inventory_sha256 = hash(
    required(members.get(required(payloadRoles.inventory_observation))),
  );
  bound_inputs.host_help_sha256 = hash(
    required(members.get(required(payloadRoles.host_help_observation))),
  );
  bound_inputs.context_sha256 = hash(
    required(members.get(required(payloadRoles.context_inventory))),
  );
  const manifest = {
    schemaVersion: '1.0.0',
    canonicalization: 'DEVAI-CANONICAL-JSON-V1',
    signature_domain: DOMAIN.trim(),
    repository: 'aarusso-nyx/devai',
    candidate,
    producer_control,
    working_agent,
    evaluator,
    created_at: '2026-10-02T09:00:00.000Z',
    invocation_id: 'offline-invocation',
    bound_inputs,
    reply_sha256: hash(reply),
    host_envelope_sha256: hash(required(members.get(required(payloadRoles.host_envelope)))),
    score_projection_sha256: hash(canonical(score)),
    payload_roles: payloadRoles,
    members: [...members]
      .map(([path, bytes]) => ({ path, byte_length: bytes.length, sha256: hash(bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const trust = {
    schemaVersion: '1.0.0',
    repository: manifest.repository,
    evidence_commit: '1'.repeat(40),
    payload_sha256: '',
    candidate: { ...candidate },
    producer_control: { ...producer_control },
    working_agent: { ...working_agent },
    custodian_id: 'separate-custodian',
    evaluator_identity: { ...evaluator },
    public_key_spki_der_base64: publicKey.toString('base64'),
    key_id: hash(publicKey),
    algorithm: 'Ed25519',
    canonicalization: manifest.canonicalization,
    signature_domain: manifest.signature_domain,
    selected_at: '2026-10-02T09:01:00.000Z',
    expires_at: '2026-10-03T09:00:00.000Z',
  };
  const input = {
    manifestBytes: Buffer.alloc(0),
    signature: Buffer.alloc(0),
    trustBytes: Buffer.alloc(0),
    members,
    expected: {
      repository: manifest.repository,
      evidenceCommit: trust.evidence_commit,
      candidate: { ...candidate },
      producerControl: { ...producer_control },
      workingAgent: { ...working_agent },
      boundInputs: { ...bound_inputs },
    },
    now: NOW,
    sourceFiles,
  };
  const seal = () => {
    input.manifestBytes = canonical(manifest);
    trust.payload_sha256 = hash(input.manifestBytes);
    input.trustBytes = canonical(trust);
    input.signature = sign(
      null,
      Buffer.concat([Buffer.from(DOMAIN), input.manifestBytes]),
      keys.privateKey,
    );
  };
  seal();
  return { input, manifest, trust, host, score, publicKey };
}

type VerifiedResult = Readonly<{ status: string }>;
type GateResult = { status: string; findings: readonly { invariant_id?: string; code?: string }[] };
async function gateModule() {
  return (await import('../../packages/sensors/src/ci-invariant-gate.js')) as {
    verifySoftGatePayload: (input: unknown) => VerifiedResult;
    consumeVerifiedSoftGatePayload: (input: unknown) => VerifiedResult;
    validateScoredSoftGate: (input: unknown) => VerifiedResult;
    evaluateCiInvariantGate: (input: unknown) => GateResult;
  };
}
async function acceptedControl() {
  const f = fixture();
  const module = await gateModule();
  const hostModule = (await import(
    new URL('../../packages/skills/src/model-bridge/soft-gate-observation.js', import.meta.url).href
  )) as {
    verifySoftGateHostObservation: (input: unknown) => VerifiedResult;
  };
  const verifiedHostObservation = hostModule.verifySoftGateHostObservation(f.host);
  expect(verifiedHostObservation.status).toBe('pass');
  const verifiedSoftEvidence = module.verifySoftGatePayload(f.input);
  expect(verifiedSoftEvidence.status).toBe('pass');
  const custody = {
    verifiedPayload: verifiedSoftEvidence,
    trustBytes: f.input.trustBytes,
    members: f.input.members,
    expected: f.input.expected,
    now: f.input.now,
  };
  expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
  const scoreInput = {
    score: f.score,
    rubric: JSON.parse(required(f.input.members.get('effective_rubric.json')).toString('utf8')),
    thresholds: JSON.parse(
      required(f.input.members.get('effective_thresholds.json')).toString('utf8'),
    ),
    sourceFiles: f.input.sourceFiles,
  };
  expect(module.validateScoredSoftGate(scoreInput).status).toBe('pass');
  const value = {
    invariants: [
      { id: 'INV-CORE-003', severity: 'constitutional' },
      { id: 'INV-HARNESS-006', severity: 'gate' },
    ],
    traceEntries: [
      { invariant_id: 'INV-CORE-003', tests: [TEST_PATH] },
      { invariant_id: 'INV-HARNESS-006', tests: [TEST_PATH] },
    ],
    hardVerdicts: [{ invariant_id: 'INV-CORE-003', status: 'pass' }],
    candidate: f.input.expected.candidate,
    producerControl: f.input.expected.producerControl,
    workingAgent: f.input.expected.workingAgent,
    boundInputs: f.input.expected.boundInputs,
    verifiedSoftEvidence,
    verifiedHostObservation,
    softEvidenceCustody: custody,
    hostObservation: f.host,
    scoreInput,
    testFiles: new Map([[TEST_PATH, readFileSync(resolve(ROOT, TEST_PATH))]]),
    trackedTestPaths: [TEST_PATH],
  };
  // Do not clone/serialize capabilities: only actual verifier return objects reach the gate.
  expect(module.evaluateCiInvariantGate(value).status).toBe('pass');
  return { value, module, custody };
}
function assertCausalRefusal(result: GateResult, invariantId: string | undefined, code: string) {
  expect(result.status).not.toBe('pass');
  // Typed internal diagnostic contract, not a new public CLI action or runtime claim.
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      code,
      ...(invariantId === undefined ? {} : { invariant_id: invariantId }),
    }),
  );
}
describe('CI gate rejects incomplete or contradictory observations', () => {
  it('pins native signature and every raw host/candidate/control member of the offline control', () => {
    const f = fixture();
    const key = createPublicKey({ key: f.publicKey, type: 'spki', format: 'der' });
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(DOMAIN), f.input.manifestBytes]),
        key,
        f.input.signature,
      ),
    ).toBe(true);
    expect(hash(f.input.manifestBytes)).toBe(f.trust.payload_sha256);
    expect(f.manifest.members).toHaveLength(roles.length);
    for (const member of f.manifest.members) {
      const bytes = required(f.input.members.get(member.path));
      expect(bytes.length).toBe(member.byte_length);
      expect(hash(bytes)).toBe(member.sha256);
    }
    expect(f.input.members.get('host_envelope.json')).toEqual(f.host.invocation.stdout);
    expect(f.input.members.get('configuration_observation.json')).toEqual(
      f.host.configurationBytes,
    );
    expect(f.input.members.get('host_help_observation.json')).toEqual(f.host.hostHelp.stdout);
    expect(f.manifest.producer_control.executable_sha256).toBe(hash(f.host.executable.bytes));
    expect(f.manifest.candidate).toEqual(f.input.expected.candidate);
    expect(f.manifest.evaluator).not.toEqual(f.manifest.working_agent);
  });
  it('admits the complete control only through actual opaque payload and completed host verifiers', async () => {
    await acceptedControl();
  });
  it.each(['review', 'fail', 'error', 'unknown', 'maybe'])(
    'cannot admit hard verdict %s',
    async (status) => {
      const { value, module, custody } = await acceptedControl();
      required(value.hardVerdicts[0]).status = status;
      expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
      const result = module.evaluateCiInvariantGate(value);
      expect(result.status).not.toBe('pass');
      expect(result.findings.some((f) => f.invariant_id === 'INV-CORE-003')).toBe(true);
      assertCausalRefusal(result, 'INV-CORE-003', 'CI_GATE_HARD_VERDICT_NOT_PASS');
    },
  );
  it('rejects a dangling or unknown invariant before any readiness claim', async () => {
    const { value, module, custody } = await acceptedControl();
    value.traceEntries.push({ invariant_id: 'INV-NOT-REGISTERED-999', tests: [TEST_PATH] });
    expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
    assertCausalRefusal(
      module.evaluateCiInvariantGate(value),
      'INV-NOT-REGISTERED-999',
      'CI_GATE_TRACE_UNKNOWN_INVARIANT',
    );
  });
  it.each(['invariants', 'traceEntries'] as const)(
    'refuses only the empty %s population',
    async (field) => {
      const { value, module, custody } = await acceptedControl();
      value[field] = [];
      expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
      assertCausalRefusal(
        module.evaluateCiInvariantGate(value),
        undefined,
        field === 'invariants'
          ? 'CI_GATE_INVARIANT_POPULATION_EMPTY'
          : 'CI_GATE_TRACE_POPULATION_EMPTY',
      );
    },
  );
  it('does not treat missing hard evidence as pass', async () => {
    const { value, module, custody } = await acceptedControl();
    value.hardVerdicts = [];
    expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
    assertCausalRefusal(
      module.evaluateCiInvariantGate(value),
      'INV-CORE-003',
      'CI_GATE_HARD_EVIDENCE_MISSING',
    );
  });
  it('refuses a registered readiness invariant whose trace entry is absent', async () => {
    const { value, module, custody } = await acceptedControl();
    value.traceEntries = value.traceEntries.filter(
      (entry) => entry.invariant_id !== 'INV-CORE-003',
    );
    expect(module.consumeVerifiedSoftGatePayload(custody).status).toBe('pass');
    assertCausalRefusal(
      module.evaluateCiInvariantGate(value),
      'INV-CORE-003',
      'CI_GATE_TRACE_INVARIANT_MISSING',
    );
  });
  it('refuses serialized verified:true and plain pass declarations as soft evidence', async () => {
    for (const fake of [
      { verified: true },
      { status: 'pass', isolated: true, completed: true },
      { scores: [4, 4, 4, 4], signature: 'signed' },
    ]) {
      const { value, module } = await acceptedControl();
      expect(
        module.evaluateCiInvariantGate({ ...value, verifiedSoftEvidence: fake }).status,
      ).not.toBe('pass');
    }
  });
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('OFFLINE_FIXTURE_REQUIRED_VALUE_MISSING');
  return value;
}
