// Invariants: INV-HARNESS-006
// ADR-MDL-0004 IA-006/007/008/009/010. All keys/bytes are ephemeral offline fixtures.
// A cryptographic payload PASS never proves an independent actual live observation.
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../packages/utils/src/index.js';
import { getValidator } from '../../packages/schemas/src/index.js';
const offlineGuard = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const attempts: string[] = [];
  const retained: {
    object: object;
    key: string;
    descriptor: PropertyDescriptor | undefined;
  }[] = [];
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
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
  const candidate = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    base_commit: 'c'.repeat(40),
  };
  const producer_control = {
    commit: 'd'.repeat(40),
    tree: 'e'.repeat(40),
    executable_sha256: 'f'.repeat(64),
  };
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
  const members = new Map(
    roles.map((role) => [required(payloadRoles[role]), canonical({ role, offline_fixture: true })]),
  );
  const reply = Buffer.from(`Selected fixture.\n\`\`\`json\n${JSON.stringify(score)}\n\`\`\``);
  members.set(required(payloadRoles.score_reply), reply);
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
    sourceFiles: new Map([['law/reference.md', source]]),
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
  const sealRaw = (bytes: Buffer) => {
    input.manifestBytes = bytes;
    trust.payload_sha256 = hash(bytes);
    input.trustBytes = canonical(trust);
    input.signature = sign(null, Buffer.concat([Buffer.from(DOMAIN), bytes]), keys.privateKey);
  };
  seal();
  return { input, manifest, trust, seal, sealRaw, keys };
}
async function verifier() {
  return (await import(
    new URL('../../packages/sensors/src/ci-invariant-gate.js', import.meta.url).href
  )) as {
    verifySoftGatePayload: (input: unknown) => {
      status: string;
    };
    evaluateCiInvariantGate: (input: unknown) => {
      status: string;
    };
    consumeVerifiedSoftGatePayload: (input: unknown) => { status: string };
    verifySoftGateHostObservation: (input: unknown) => { status: string };
  };
}
describe('canonical signature and exact payload custody component (offline)', () => {
  it('pins actual closed schema validity and native Ed25519 verification for the complete offline fixture', () => {
    const { input, manifest, trust } = fixture();
    expect(getValidator('soft-gate-evidence.schema.json')(manifest)).toBe(true);
    expect(getValidator('soft-gate-trust.schema.json')(trust)).toBe(true);
    const key = createPublicKey({
      key: Buffer.from(trust.public_key_spki_der_base64, 'base64'),
      type: 'spki',
      format: 'der',
    });
    expect(
      verify(null, Buffer.concat([Buffer.from(DOMAIN), input.manifestBytes]), key, input.signature),
    ).toBe(true);
    expect(hash(input.manifestBytes)).toBe(trust.payload_sha256);
    expect(input.signature.length).toBe(64);
  });
  it('verifies an externally selected key and exact raw noncanonical fenced reply independently of canonical score projection', async () => {
    const { input } = fixture();
    expect((await verifier()).verifySoftGatePayload(input).status).toBe('pass');
  });
  it.each([
    'candidate',
    'base',
    'control',
    'source',
    'lockfile',
    'toolchain',
    'roster',
    'context',
    'rubric',
    'thresholds',
    'configuration',
    'inventory',
    'hostHelp',
  ])('refuses an independently expected %s identity substitution', async (field) => {
    const { input } = fixture();
    if (field === 'candidate') input.expected.candidate.commit = '2'.repeat(40);
    else if (field === 'base') input.expected.candidate.base_commit = '2'.repeat(40);
    else if (field === 'control') input.expected.producerControl.commit = '2'.repeat(40);
    else {
      const map: Record<string, string> = {
        source: 'source_population_sha256',
        lockfile: 'lockfile_population_sha256',
        toolchain: 'toolchain_sha256',
        roster: 'task_roster_sha256',
        context: 'context_sha256',
        rubric: 'rubric_sha256',
        thresholds: 'thresholds_sha256',
        configuration: 'configuration_sha256',
        inventory: 'inventory_sha256',
        hostHelp: 'host_help_sha256',
      };
      input.expected.boundInputs[required(map[field])] = '2'.repeat(64);
    }
    expect((await verifier()).verifySoftGatePayload(input).status).not.toBe('pass');
  });
  it.each(['expired', 'stale', 'future', 'shared-agent', 'shared-session', 'shared-process'])(
    'rejects signed but semantically invalid %s payload',
    async (fault) => {
      const { input, manifest, trust, seal } = fixture();
      if (fault === 'expired') trust.expires_at = '2026-10-02T09:30:00.000Z';
      if (fault === 'stale') manifest.created_at = '2026-09-30T09:00:00.000Z';
      if (fault === 'future') manifest.created_at = '2026-10-02T10:00:00.001Z';
      const key = (
        {
          'shared-agent': 'agent_id',
          'shared-session': 'session_id',
          'shared-process': 'process_instance_id',
        } as const
      )[fault as 'shared-agent'];
      if (key !== undefined) {
        manifest.evaluator[key] = manifest.working_agent[key];
        trust.evaluator_identity[key] = manifest.evaluator[key];
      }
      seal();
      expect((await verifier()).verifySoftGatePayload(input).status).not.toBe('pass');
    },
  );
  it.each([
    'manifest-whitespace',
    'trust-whitespace',
    'key-encoding',
    'signature-length',
    'score-projection',
    'duplicate-key',
    'signature',
    'key',
    'wrong-domain',
    'reply',
    'envelope',
    'missing',
    'extra',
    'member-length',
    'member-hash',
    'role-alias',
    'self-member',
    'unsafe-path',
    'non-NFC',
    'unknown-field',
  ])('rejects %s without accepting declarations as custody', async (fault) => {
    const { input, manifest, trust, seal, sealRaw } = fixture();
    switch (fault) {
      case 'manifest-whitespace':
        sealRaw(Buffer.concat([input.manifestBytes, Buffer.from('\n')]));
        break;
      case 'duplicate-key':
        sealRaw(
          Buffer.from(input.manifestBytes.toString().replace('{', '{"schemaVersion":"1.0.0",')),
        );
        break;
      case 'trust-whitespace':
        input.trustBytes = Buffer.concat([input.trustBytes, Buffer.from('\n')]);
        break;
      case 'key-encoding':
        trust.public_key_spki_der_base64 += '\n';
        seal();
        break;
      case 'signature-length':
        input.signature = input.signature.subarray(1);
        break;
      case 'score-projection':
        manifest.score_projection_sha256 = '0'.repeat(64);
        seal();
        break;
      case 'signature':
        input.signature[0] = required(input.signature[0]) ^ 1;
        break;
      case 'key':
        trust.public_key_spki_der_base64 = generateKeyPairSync('ed25519')
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64');
        seal();
        break;
      case 'wrong-domain':
        manifest.signature_domain = 'OTHER-DOMAIN';
        seal();
        break;
      case 'reply':
        input.members.set(required(manifest.payload_roles.score_reply), Buffer.from('{}'));
        break;
      case 'envelope':
        input.members.set(required(manifest.payload_roles.host_envelope), Buffer.from('{}'));
        break;
      case 'missing':
        input.members.delete(required(manifest.payload_roles.inventory_observation));
        break;
      case 'extra':
        input.members.set('unlisted.json', Buffer.from('{}'));
        break;
      case 'member-length':
        required(manifest.members[0]).byte_length++;
        seal();
        break;
      case 'member-hash':
        required(manifest.members[0]).sha256 = '0'.repeat(64);
        seal();
        break;
      case 'role-alias':
        manifest.payload_roles.host_envelope = required(manifest.payload_roles.score_reply);
        seal();
        break;
      case 'self-member':
        manifest.members.push({
          path: 'manifest.json',
          byte_length: 0,
          sha256: hash(Buffer.alloc(0)),
        });
        seal();
        break;
      case 'unsafe-path':
        required(manifest.members[0]).path = '../escape';
        seal();
        break;
      case 'non-NFC':
        required(manifest.members[0]).path = 'cafe\u0301.json';
        seal();
        break;
      case 'unknown-field':
        Object.assign(manifest, { verified: true, isolated: true });
        seal();
        break;
    }
    expect((await verifier()).verifySoftGatePayload(input).status).not.toBe('pass');
  });
  it.each(['member-count', 'member-size', 'total-size', 'manifest-size'])(
    'refuses exact signed %s limit breach',
    async (limit) => {
      const { input, manifest, seal } = fixture();
      if (limit === 'member-count')
        for (let i = 0; i < 65; i++)
          input.members.set(`extra-${String(i).padStart(2, '0')}.json`, Buffer.from('{}'));
      if (limit === 'member-size')
        input.members.set('oversize.bin', Buffer.alloc(16 * 1024 * 1024 + 1));
      if (limit === 'total-size')
        for (let i = 0; i < 3; i++)
          input.members.set(`large-${i}.bin`, Buffer.alloc(12 * 1024 * 1024));
      manifest.members = [...input.members]
        .map(([path, bytes]) => ({ path, byte_length: bytes.length, sha256: hash(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      if (limit === 'manifest-size') manifest.invocation_id = 'x'.repeat(1024 * 1024);
      seal();
      expect((await verifier()).verifySoftGatePayload(input).status).not.toBe('pass');
    },
  );
  it('refuses absent trust and rechecks byte custody of the opaque payload component at consumption', async () => {
    const { input } = fixture();
    const module = await verifier();
    expect(module.verifySoftGatePayload({ ...input, trustBytes: undefined }).status).not.toBe(
      'pass',
    );
    const verified = module.verifySoftGatePayload(input);
    expect(verified.status).toBe('pass');
    const consume = (verifiedPayload: unknown) =>
      module.consumeVerifiedSoftGatePayload({
        verifiedPayload,
        trustBytes: input.trustBytes,
        members: input.members,
        expected: input.expected,
        now: input.now,
      });
    expect(consume(verified).status).toBe('pass');
    for (const fake of [JSON.parse(JSON.stringify(verified)), { verified: true, status: 'pass' }])
      expect(consume(fake).status).not.toBe('pass');
    input.members.set('score_reply.json', Buffer.from('{}'));
    expect(consume(verified).status).not.toBe('pass');
  });
  it('refuses external trust and expected candidate mutations between payload verification and consumption', async () => {
    for (const fault of ['trust', 'candidate', 'base']) {
      const { input } = fixture();
      const module = await verifier();
      const verified = module.verifySoftGatePayload(input);
      expect(verified.status).toBe('pass');
      if (fault === 'trust') input.trustBytes = Buffer.from('{}');
      if (fault === 'candidate') input.expected.candidate.commit = '0'.repeat(40);
      if (fault === 'base') input.expected.candidate.base_commit = '0'.repeat(40);
      expect(
        module.consumeVerifiedSoftGatePayload({
          verifiedPayload: verified,
          trustBytes: input.trustBytes,
          members: input.members,
          expected: input.expected,
          now: input.now,
        }).status,
      ).not.toBe('pass');
    }
  });
});
// The I/O wrapper receives only injected HTTP fixtures under native effect denial.
// Successful staging is byte custody only; host verification/admission remains separate.
function transport(fault = '') {
  const { input, trust, manifest, seal } = fixture();
  if (fault === 'tree-depth') {
    const old = required(manifest.payload_roles.configuration_observation);
    const next = Array.from({ length: 9 }, (_, i) => `level-${i}`).join('/') + '/' + old;
    input.members.set(next, required(input.members.get(old)));
    input.members.delete(old);
    manifest.payload_roles.configuration_observation = next;
    manifest.members = [...input.members]
      .map(([path, bytes]) => ({ path, byte_length: bytes.length, sha256: hash(bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    seal();
  }
  const bodyObservation = { reads: 0, cancelled: false };
  const prefix = `evidence/${trust.candidate.commit}/${trust.payload_sha256}`;
  const objects = new Map<string, unknown>();
  const blob = (bytes: Buffer) => {
    const sha = createHash('sha1')
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest('hex');
    objects.set(`blobs/${sha}`, {
      sha,
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
    return { sha, size: bytes.length };
  };
  const leaf = [...input.members].map(([path, bytes]) => ({
    path,
    mode: '100644',
    type: 'blob',
    ...blob(bytes),
  }));
  leaf.push(
    { path: 'manifest.json', mode: '100644', type: 'blob', ...blob(input.manifestBytes) },
    { path: 'signature.ed25519', mode: '100644', type: 'blob', ...blob(input.signature) },
  );
  const tree = (entries: typeof leaf): string => {
    const flat: typeof leaf = [];
    const nested = new Map<string, typeof leaf>();
    for (const entry of entries) {
      const split = entry.path.indexOf('/');
      if (split < 0) flat.push(entry);
      else {
        const directory = entry.path.slice(0, split);
        const children = nested.get(directory) ?? [];
        children.push({ ...entry, path: entry.path.slice(split + 1) });
        nested.set(directory, children);
      }
    }
    for (const [path, children] of nested)
      flat.push({ path, mode: '040000', type: 'tree', sha: tree(children), size: 0 });
    const sorted = [...flat].sort((a, b) => (a.path < b.path ? -1 : 1));
    const raw = Buffer.concat(
      sorted.map((entry) =>
        Buffer.concat([
          Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`),
          Buffer.from(entry.sha, 'hex'),
        ]),
      ),
    );
    const sha = createHash('sha1')
      .update(Buffer.from(`tree ${raw.length}\0`))
      .update(raw)
      .digest('hex');
    objects.set(`trees/${sha}`, { sha, truncated: false, tree: sorted });
    return sha;
  };
  const payloadTree = tree(leaf);
  const candidateTree = tree([
    { path: trust.payload_sha256, mode: '040000', type: 'tree', sha: payloadTree, size: 0 },
  ]);
  const evidenceTree = tree([
    { path: trust.candidate.commit, mode: '040000', type: 'tree', sha: candidateTree, size: 0 },
  ]);
  const rootTree = tree([
    { path: 'evidence', mode: '040000', type: 'tree', sha: evidenceTree, size: 0 },
  ]);
  objects.set(`commits/${trust.evidence_commit}`, {
    sha: trust.evidence_commit,
    tree: { sha: rootTree },
  });
  if (fault === 'wrong-repository') {
    trust.repository = 'someone/else';
    input.trustBytes = canonical(trust);
  }
  if (fault === 'symbolic-ref') {
    trust.evidence_commit = 'main';
    input.trustBytes = canonical(trust);
  }
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, options?: RequestInit) => {
    requests.push({ url: String(url), options });
    if (fault === 'transport-timeout')
      throw new DOMException('Offline deadline fixture', 'TimeoutError');
    if (fault === 'oversize-encoded-body' && String(url).includes('/git/blobs/'))
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodyObservation.reads++;
              if (bodyObservation.reads > 3) throw new Error('BODY_CONSUMED_BEYOND_BOUND');
              controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
            },
            cancel() {
              bodyObservation.cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    if (fault === 'redirect')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.invalid/' },
      });
    if (fault === 'rate-limit') return new Response('{}', { status: 429 });
    if (fault === 'oversize-metadata') return new Response('x'.repeat(2 * 1024 * 1024 + 1));
    const key = String(url).split('/git/')[1];
    const original = objects.get(key ?? '');
    if (original === undefined) throw new Error(`UNDECLARED_FIXTURE_OBJECT:${String(url)}`);
    const value = structuredClone(original) as {
      sha?: string;
      truncated?: boolean;
      tree?: typeof leaf;
      size?: number;
      content?: string;
    };
    if (key === `trees/${payloadTree}`) {
      if (fault === 'truncated-tree') value.truncated = true;
      if (fault === 'symlink')
        required(value.tree)[0] = { ...required(required(value.tree)[0]), mode: '120000' };
      if (fault === 'submodule')
        required(value.tree)[0] = {
          ...required(required(value.tree)[0]),
          mode: '160000',
          type: 'commit',
        };
      if (fault === 'missing-member') required(value.tree).pop();
      if (fault === 'extra-member')
        required(value.tree).push({
          path: 'unlisted.json',
          mode: '100644',
          type: 'blob',
          ...blob(Buffer.from('{}')),
        });
      if (fault === 'duplicate-member')
        required(value.tree).push({ ...required(required(value.tree)[0]) });
    }
    if (key?.startsWith('blobs/')) {
      if (fault === 'wrong-object-id') value.sha = '9'.repeat(40);
      if (fault === 'wrong-size') value.size = required(value.size) + 1;
      if (fault === 'bad-base64') value.content = '!not canonical base64!';
      if (fault === 'oversize-member') value.size = 16 * 1024 * 1024 + 1;
    }
    return Response.json(value);
  });
  return { input, requests, fetchImpl, prefix, bodyObservation };
}
async function fetchFixture(value: ReturnType<typeof transport>) {
  const module = (await import(
    new URL('../../scripts/process/fetch-ci-invariant-evidence.mjs', import.meta.url).href
  )) as {
    fetchCiInvariantEvidence: (input: unknown) => Promise<{
      manifestBytes: Uint8Array;
      signature: Uint8Array;
      members: Map<string, Uint8Array>;
    }>;
  };
  return module.fetchCiInvariantEvidence({
    trustBytes: value.input.trustBytes,
    expected: value.input.expected,
    now: NOW,
    fetchImpl: value.fetchImpl,
  });
}
function assertTransportRequests(requests: ReturnType<typeof transport>['requests']) {
  expect(requests.length).toBeLessThanOrEqual(128);
  const urls = requests.map((request) => request.url);
  expect(new Set(urls).size).toBe(urls.length);
  for (const request of requests) {
    expect(request.url).toMatch(
      /^https:\/\/api\.github\.com\/repos\/aarusso-nyx\/devai\/git\/(commits|trees|blobs)\/[a-f0-9]{40}$/u,
    );
    expect(request.options?.redirect).toBe('manual');
    expect(JSON.stringify(request.options?.headers ?? {})).not.toMatch(
      /authorization|token|secret/i,
    );
  }
}
describe('fixed public repository transport (offline)', () => {
  it('retrieves exact immutable commit/tree/blob payload bytes from the complete positive fixture', async () => {
    const value = transport();
    const fetched = await fetchFixture(value);
    expect(Buffer.from(fetched.manifestBytes)).toEqual(value.input.manifestBytes);
    expect(Buffer.from(fetched.signature)).toEqual(value.input.signature);
    expect(fetched.members).toEqual(value.input.members);
    assertTransportRequests(value.requests);
  });
  it.each([
    'redirect',
    'rate-limit',
    'truncated-tree',
    'symlink',
    'submodule',
    'wrong-repository',
    'symbolic-ref',
    'oversize-metadata',
    'missing-member',
    'extra-member',
    'duplicate-member',
    'wrong-object-id',
    'wrong-size',
    'bad-base64',
    'oversize-member',
    'tree-depth',
    'transport-timeout',
    'oversize-encoded-body',
  ])(
    'refuses isolated %s transport mutation with no retry or credential fallback',
    async (fault) => {
      const value = transport(fault);
      await expect(fetchFixture(value)).rejects.toThrow();
      assertTransportRequests(value.requests);
      if (fault === 'wrong-repository' || fault === 'symbolic-ref')
        expect(value.requests).toEqual([]);
      else expect(value.requests.length).toBeGreaterThan(0);
      if (fault === 'oversize-encoded-body') {
        expect(value.bodyObservation.reads).toBeLessThanOrEqual(3);
        expect(value.bodyObservation.cancelled).toBe(true);
      }
      if (fault === 'transport-timeout') expect(value.requests).toHaveLength(1);
    },
  );
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('OFFLINE_FIXTURE_REQUIRED_VALUE_MISSING');
  return value;
}

// Exact threshold byte custody is independent of comparator/schema validity.
// All host bytes below are declared offline component fixtures under native effect denial.
function rawThresholdFixture() {
  const f = fixture();
  const role = required(f.manifest.payload_roles.effective_thresholds);
  const value = JSON.parse(required(f.input.members.get(role)).toString('utf8'));
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const bind = (next: Buffer) => {
    f.input.members.set(role, next);
    f.manifest.members = [...f.input.members]
      .map(([path, raw]) => ({ path, byte_length: raw.length, sha256: hash(raw) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    f.manifest.bound_inputs.thresholds_sha256 = hash(next);
    f.input.expected.boundInputs.thresholds_sha256 = hash(next);
    f.seal();
  };
  bind(bytes);
  return { f, role, value, bytes, bind };
}
function offlineProducerHost(f: ReturnType<typeof fixture>) {
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
  const reply = required(f.input.members.get('score_reply.json'));
  const events = [
    { type: 'thread.started', tools: [], mcp_servers: [] },
    {
      type: 'item.completed',
      item: { id: 'final', type: 'agent_message', text: reply.toString('utf8') },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  return {
    workingAgent: f.manifest.working_agent,
    evaluator: f.manifest.evaluator,
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
      process_instance_id: f.manifest.evaluator.process_instance_id,
      argv,
      status: 0,
      stdout: Buffer.from(events.map((e) => JSON.stringify(e)).join('\n')),
      stderr: Buffer.alloc(0),
    },
  };
}
describe('raw threshold custody regressions (offline component)', () => {
  it.each(['format-only', 'key-order', 'canonical-projection'])(
    'refuses %s substitution after authentic raw control and opaque consumption pass',
    async (fault) => {
      const { f, role, value, bytes } = rawThresholdFixture();
      const module = await verifier();
      const verified = module.verifySoftGatePayload(f.input);
      expect(verified.status).toBe('pass');
      const consume = () =>
        module.consumeVerifiedSoftGatePayload({
          verifiedPayload: verified,
          trustBytes: f.input.trustBytes,
          members: f.input.members,
          expected: f.input.expected,
          now: f.input.now,
        });
      expect(consume().status).toBe('pass');
      const next =
        fault === 'format-only'
          ? Buffer.from(JSON.stringify(value) + '\n')
          : fault === 'key-order'
            ? Buffer.from(
                JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 2) + '\n',
              )
            : canonical(value);
      expect(JSON.parse(next.toString('utf8'))).toEqual(value);
      expect(hash(next)).not.toBe(hash(bytes));
      f.input.members.set(role, next);
      expect(consume()).toMatchObject({
        status: 'error',
        findings: [{ code: 'CI_GATE_PAYLOAD_CUSTODY_CHANGED' }],
      });
      // Authentically re-sign every changed member while retaining the independently selected raw digest.
      f.manifest.members = [...f.input.members]
        .map(([path, raw]) => ({ path, byte_length: raw.length, sha256: hash(raw) }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      f.manifest.bound_inputs.thresholds_sha256 = hash(next);
      f.seal();
      expect(module.verifySoftGatePayload(f.input)).toMatchObject({
        status: 'error',
        findings: [{ code: 'CI_GATE_PAYLOAD_INVALID' }],
      });
    },
  );
  it('retains observed raw threshold bytes in the actual producer member and rejects parsed/projection substitution', async () => {
    // The producer checks createdAt against the wall clock (24h window); pin only Date to the
    // fixture's NOW so the case does not expire with real time. Timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const { f, role, value, bytes } = rawThresholdFixture();
      const gate = await verifier();
      const host = offlineProducerHost(f);
      expect(gate.verifySoftGateHostObservation(host).status).toBe('pass');
      const rubric = JSON.parse(
        required(f.input.members.get('effective_rubric.json')).toString('utf8'),
      );
      const boundInputs = { ...f.input.expected.boundInputs };
      boundInputs.source_population_sha256 = hash(
        canonical(
          [...f.input.sourceFiles].map(([path, raw]) => ({
            path,
            byte_length: raw.length,
            sha256: hash(raw),
          })),
        ),
      );
      boundInputs.configuration_sha256 = hash(host.configurationBytes);
      boundInputs.inventory_sha256 = hash(
        canonical({ tools: [], mcp_servers: [], hooks: [], plugins: [], agents: [] }),
      );
      boundInputs.host_help_sha256 = hash(host.hostHelp.stdout);
      boundInputs.context_sha256 = hash(
        canonical({ inheritedConversation: false, messages: [], agents: [] }),
      );
      const expected = {
        ...f.input.expected,
        producerControl: {
          ...f.input.expected.producerControl,
          executable_sha256: host.selectedControls.executableSha256,
        },
        boundInputs,
      };
      const reply = required(f.input.members.get('score_reply.json')).toString('utf8');
      const args = {
        envelope: {
          operation: 'scored-llm-judge',
          invocation_id: 'offline-invocation',
          candidate: expected.candidate,
          timeout_ms: 10000,
          max_output_bytes: 1024 * 1024,
          max_cost_usd: 0,
          no_tools: true,
          no_mcp: true,
        },
        client: {
          family: 'codex-cli',
          complete: async () => ({
            text: reply,
            finish_reason: 'stop',
            usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
            latency_ms: 1,
            host_observation: host,
          }),
        },
        observeHost: async (raw: unknown) => {
          expect(raw).toBe(host);
          return host;
        },
        signManifest: async (message: Uint8Array) =>
          sign(null, Buffer.from(message), f.keys.privateKey),
        expected,
        rubric,
        thresholds: value,
        thresholdBytes: bytes,
        sourceFiles: f.input.sourceFiles,
        retainedInputs: new Map(),
        createdAt: f.manifest.created_at,
        invocationId: 'offline-invocation',
      };
      const { produceCiInvariantEvidence } = await import(
        new URL('../../scripts/process/produce-ci-invariant-evidence.mjs', import.meta.url).href
      );
      // First establish the actual producer seam using independently selected compact raw bytes.
      const compactBytes = canonical(value);
      const compactExpected = {
        ...expected,
        boundInputs: { ...boundInputs, thresholds_sha256: hash(compactBytes) },
      };
      const compactControl = await produceCiInvariantEvidence({
        ...args,
        thresholdBytes: compactBytes,
        expected: compactExpected,
      });
      expect(compactControl.reading.status).toBe('pass');
      expect(compactControl.members.get(role)).toEqual(compactBytes);
      const produced = await produceCiInvariantEvidence(args);
      expect(produced.reading.status).toBe('pass');
      expect(produced.members.get(role)).toEqual(bytes);
      const manifest = JSON.parse(Buffer.from(produced.manifestBytes).toString('utf8'));
      expect(manifest.bound_inputs.thresholds_sha256).toBe(hash(bytes));
      expect(manifest.bound_inputs.thresholds_sha256).not.toBe(hash(canonical(value)));
      f.trust.producer_control = { ...expected.producerControl };
      f.trust.payload_sha256 = hash(produced.manifestBytes);
      const payloadInput = { ...f.input, ...produced, expected, trustBytes: canonical(f.trust) };
      const verified = gate.verifySoftGatePayload(payloadInput);
      expect(verified.status).toBe('pass');
      expect(
        gate.consumeVerifiedSoftGatePayload({
          verifiedPayload: verified,
          trustBytes: payloadInput.trustBytes,
          members: produced.members,
          expected,
          now: payloadInput.now,
        }).status,
      ).toBe('pass');
      // The valid raw control must succeed first; only then change the raw observation/parsed agreement.
      await expect(
        produceCiInvariantEvidence({ ...args, thresholdBytes: canonical(value) }),
      ).rejects.toThrow('CI_EVIDENCE_PRODUCER_REFUSED');
      await expect(
        produceCiInvariantEvidence({ ...args, thresholdBytes: undefined }),
      ).rejects.toThrow('CI_EVIDENCE_PRODUCER_REFUSED');
      await expect(
        produceCiInvariantEvidence({ ...args, thresholdBytes: Buffer.from('{}') }),
      ).rejects.toThrow('CI_EVIDENCE_PRODUCER_REFUSED');
      // The pinned clock keeps the freshness window effective at both edges.
      await expect(
        produceCiInvariantEvidence({ ...args, createdAt: '2026-10-01T09:59:59.999Z' }),
      ).rejects.toThrow('CI_EVIDENCE_PRODUCER_REFUSED');
      await expect(
        produceCiInvariantEvidence({ ...args, createdAt: '2026-10-02T10:00:00.001Z' }),
      ).rejects.toThrow('CI_EVIDENCE_PRODUCER_REFUSED');
      // Both window edges are inclusive (createdAt <= now, now - createdAt <= 24h): evidence created
      // exactly at the pinned clock and exactly 24h before it is accepted.
      for (const createdAt of [NOW, '2026-10-01T10:00:00.000Z']) {
        const edge = await produceCiInvariantEvidence({ ...args, createdAt });
        expect(edge.reading.status).toBe('pass');
        expect(JSON.parse(Buffer.from(edge.manifestBytes).toString('utf8')).created_at).toBe(
          createdAt,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
