import { existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const sourcePath = resolve(ROOT, 'packages/authority/src/runtime/reconciliation-owner-record.ts');
const packetRoot = resolve(
  ROOT,
  'docs/dev/operations/u1-b1-recovery-20261024/release-280/b1-design',
);
const kinds = [
  'issuer',
  'approval',
  'renewal',
  'revocation',
  'phase-intent',
  'phase-completion',
  'lease',
] as const;

describe('pure reconciliation Owner record codec', () => {
  it('has the actual closed record module required by the frozen checkpoint', () => {
    expect(existsSync(sourcePath), 'actual Owner record module is absent').toBe(true);
  });
  it('retains exactly seven normative candidate variants', () => {
    const candidate = JSON.parse(
      readFileSync(resolve(packetRoot, 'owner-schema.candidate.json'), 'utf8'),
    ) as { oneOf: { $ref: string }[] };
    expect(candidate.oneOf.map((x) => x.$ref)).toEqual(kinds.map((kind) => `#/$defs/${kind}`));
  });
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordData = { [key: string]: Json };
interface OwnerApi {
  readonly ReconciliationOwnerRecordError: new (
    ...args: never[]
  ) => Error & { readonly code: string };
  validateReconciliationOwnerRecord(value: unknown): RecordData;
  signReconciliationOwnerRecord(value: unknown, key: unknown): RecordData;
  verifyReconciliationOwnerRecord(value: unknown, key: unknown): RecordData;
  encodeReconciliationOwnerRecord(value: unknown): Uint8Array;
  decodeReconciliationOwnerRecord(bytes: unknown): RecordData;
  summarizeReconciliationOwnerRecord(value: unknown): RecordData;
}
let modulePromise: Promise<OwnerApi> | undefined;
const api = (): Promise<OwnerApi> => (modulePromise ??= import(sourcePath) as Promise<OwnerApi>);
const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (11 + i * 7) % 256));
const KEY = KEY_BYTES.toString('base64');
const OTHER_KEY = Buffer.alloc(32, 91).toString('base64');
const INVALID = 'RECONCILIATION_OWNER_INVALID',
  MAC_INVALID = 'RECONCILIATION_OWNER_MAC_INVALID',
  ENCODING = 'RECONCILIATION_OWNER_ENCODING_INVALID',
  LIMIT = 'RECONCILIATION_OWNER_LIMIT_EXCEEDED';
const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
// Independent oracle is only used on locally authored trusted fixtures, not candidate copies.
// No shared canonicalJson/schema/codec helper supplies expected bytes or HMACs.
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key] ?? null))
      .join(',') +
    '}'
  );
}
const h = (label: string): string => sha(label);
const clock = (): RecordData => ({
  clock_source: 'node-uv-hrtime-ns-v1',
  boot_id: '11111111-2222-3333-4444-555555555555',
  monotonic_ns: '9007199254740993123',
  wall_ms: 1792868400000,
});
const base = (kind: string): RecordData => ({
  schemaVersion: '1.0.0',
  kind,
  domain: `devai.reconciliation.owner.v1/${kind}`,
  repository_id: 'fixture-repository',
  worktree_id: 'fixture-worktree',
  clock: clock(),
});
const scope = (): RecordData => ({
  repository_id: 'fixture-repository',
  worktree_id: 'fixture-worktree',
  host_identity_sha256: h('host'),
  binding_sha256: h('binding'),
  plan_sha256: h('plan'),
  source_manifest_sha256: h('source'),
  allowed_phases: ['01', '02', '03', '04'],
});
function unsigned(kind: (typeof kinds)[number]): RecordData {
  const common = {
    ...base(kind),
    approval_id: h('approval-id'),
    issuer_sha256: h('issuer'),
    approval_sha256: h('approval'),
    scope_sha256: sha(canonical(scope())),
  };
  const deadlines = {
    validity_ms: 900000,
    expires_wall_ms: 1792869300000,
    expires_monotonic_ns: '9007200154740993123',
  };
  if (kind === 'issuer') {
    const anchor: RecordData = {
      schemaVersion: '1.0.0',
      kind: 'reconciliation-admission-anchor',
      root: '/PRIVATE_PAYLOAD_SENTINEL_ROOT',
      root_identity: { dev: '1', ino: '2', birthtime_ns: '3', uid: '501', mode: '0700' },
      seed_identity: {
        dev: '1',
        ino: '4',
        birthtime_ns: '5',
        uid: '501',
        mode: '0600',
        size_bytes: 8192,
        mtime_ns: '6',
        ctime_ns: '7',
      },
      seed_sha256: '3f6b742405bb199a11ed0952c9aa049285ef25dc69954e901d2e987cd15c4372',
    };
    const bindings: RecordData = {
      package_sha256: h('package'),
      module_sha256: h('module'),
      registry_sha256: h('registry'),
      constitution_sha256: h('constitution'),
      policy_sha256: h('policy'),
    };
    const seed_plan_sha256 = h('seed-plan'),
      host_identity_sha256 = h('host'),
      installed_at_head = 'a'.repeat(40);
    const context = {
      seed_plan_sha256,
      host_identity_sha256,
      admission_anchor_sha256: sha(canonical(anchor)),
      installation_bindings_sha256: sha(canonical(bindings)),
      installed_at_head,
    };
    return {
      ...base(kind),
      adapter_id: 'reconciliation-host-authority-boundary',
      host_identity_sha256,
      key_sha256: sha(KEY_BYTES),
      seed_plan_sha256,
      provision_context_sha256: sha(canonical(context)),
      admission_anchor: anchor,
      private_key_base64: KEY,
      installation_bindings: bindings,
      installed_at_head,
    };
  }
  if (kind === 'approval') {
    const { approval_sha256: _omitted, ...rest } = common;
    return { ...rest, sequence: 1, previous_grant_sha256: null, scope: scope(), ...deadlines };
  }
  if (kind === 'renewal')
    return {
      ...common,
      sequence: 2,
      previous_grant_sha256: h('grant'),
      remaining_phases: ['02', '04'],
      resumable_intent_sha256: null,
      ...deadlines,
    };
  if (kind === 'revocation') return { ...common, sequence: 2, previous_grant_sha256: h('grant') };
  if (kind === 'phase-intent')
    return {
      ...common,
      grant_sha256: h('grant'),
      before_witness_sha256: h('before'),
      output_plan_sha256: h('outputs'),
      lease_nonce: h('nonce'),
      invocation_id: h('invocation'),
      phase: '01',
      action_id: 'evidence reconcile materialize',
      initiator: 'inspector',
      predecessor_completion_sha256: null,
    };
  if (kind === 'phase-completion')
    return {
      ...common,
      intent_sha256: h('intent'),
      observed_grant_sha256: h('grant'),
      final_witness_sha256: h('final'),
      outputs_manifest_sha256: h('outputs'),
      phase: '01',
      predecessor_completion_sha256: null,
      durability: 'durable',
    };
  return {
    ...common,
    grant_sha256: h('grant'),
    original_intent_sha256: h('intent'),
    invocation_id: h('invocation'),
    nonce: h('nonce'),
    host_identity_sha256: h('host'),
    phase: '01',
    action_id: 'evidence reconcile materialize',
    initiator: 'inspector',
    pid: 123,
    hostname: 'PRIVATE_PAYLOAD_SENTINEL_HOST',
  };
}
function signed(kind: (typeof kinds)[number]): RecordData {
  const record = unsigned(kind);
  const mac = createHmac('sha256', KEY_BYTES)
    .update(Buffer.from(String(record.domain), 'utf8'))
    .update(Buffer.from([0]))
    .update(canonical(record), 'utf8')
    .digest('hex');
  return { ...record, mac };
}
const bytes = (value: RecordData): Buffer => Buffer.from(canonical(value) + '\n', 'utf8');
function expectCode(codec: OwnerApi, fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(codec.ReconciliationOwnerRecordError);
  expect(error).toMatchObject({ name: 'ReconciliationOwnerRecordError', code, message: code });
  expect(error).not.toHaveProperty('cause');
  const diagnostic = String(error);
  for (const secret of [KEY, KEY_BYTES.toString('hex'), 'PRIVATE_PAYLOAD_SENTINEL', 'SECRET_'])
    expect(diagnostic).not.toContain(secret);
}
function deepFrozen(value: Json): boolean {
  return (
    value === null ||
    typeof value !== 'object' ||
    (Object.isFrozen(value) && Object.values(value).every(deepFrozen))
  );
}

describe('independent signed seven-variant vectors', () => {
  for (const kind of kinds)
    it(`authenticates and roundtrips exact ${kind} without sharing the oracle`, async () => {
      const codec = await api();
      const input = unsigned(kind);
      const before = structuredClone(input);
      const expected = signed(kind);
      expect(codec.signReconciliationOwnerRecord(input, KEY)).toEqual(expected);
      expect(input).toEqual(before);
      const verified = codec.verifyReconciliationOwnerRecord(expected, KEY);
      expect(verified).toEqual(expected);
      expect(verified).not.toBe(expected);
      expect(deepFrozen(verified)).toBe(true);
      const encoded = codec.encodeReconciliationOwnerRecord(expected);
      expect(Buffer.from(encoded)).toEqual(bytes(expected));
      const decoded = codec.decodeReconciliationOwnerRecord(encoded);
      expect(decoded).toEqual(expected);
      expect(deepFrozen(decoded)).toBe(true);
      expect(codec.validateReconciliationOwnerRecord(expected)).toEqual(expected);
      expect(Object.isFrozen(expected)).toBe(false);
      const second = codec.encodeReconciliationOwnerRecord(expected);
      expect(second).not.toBe(encoded);
      encoded[0] = 0;
      expect(Buffer.from(second)).toEqual(bytes(expected));
    });
  for (const kind of kinds)
    it(`rejects wrong MAC/key for ${kind} but data validation never claims MAC verification`, async () => {
      const codec = await api();
      const record = { ...signed(kind), mac: '0'.repeat(64) };
      expect(codec.validateReconciliationOwnerRecord(record)).toEqual(record);
      expectCode(codec, () => codec.verifyReconciliationOwnerRecord(record, KEY), MAC_INVALID);
      expectCode(
        codec,
        () => codec.verifyReconciliationOwnerRecord(signed(kind), OTHER_KEY),
        MAC_INVALID,
      );
    });
  for (const kind of kinds)
    it(`returns only the exact private-safe summary for ${kind}`, async () => {
      const codec = await api();
      const record = signed(kind);
      const summary = codec.summarizeReconciliationOwnerRecord(record);
      expect(summary).toEqual({
        schemaVersion: '1.0.0',
        kind: 'reconciliation-owner-record-summary',
        record_kind: kind,
        repository_id: 'fixture-repository',
        worktree_id: 'fixture-worktree',
        record_sha256: sha(bytes(record)),
        size_bytes: bytes(record).length,
        approval_id: kind === 'issuer' ? null : h('approval-id'),
        scope_sha256: kind === 'issuer' ? null : sha(canonical(scope())),
        grants_authority: false,
      });
      expect(deepFrozen(summary)).toBe(true);
      for (const secret of [
        KEY,
        sha(KEY_BYTES),
        String(record.mac),
        'PRIVATE_PAYLOAD_SENTINEL',
        'private_key_base64',
        'admission_anchor',
      ])
        expect(JSON.stringify(summary)).not.toContain(secret);
    });
  it('includes domain and NUL prefix, not payload alone or an undelimited string', async () => {
    const codec = await api();
    const record = signed('revocation');
    const input = unsigned('revocation');
    for (const invalid of [
      createHmac('sha256', KEY_BYTES).update(canonical(input)).digest('hex'),
      createHmac('sha256', KEY_BYTES)
        .update(String(input.domain) + canonical(input))
        .digest('hex'),
    ])
      expectCode(
        codec,
        () => codec.verifyReconciliationOwnerRecord({ ...record, mac: invalid }, KEY),
        MAC_INVALID,
      );
  });
});

describe('closed semantics and key identity', () => {
  for (const variant of [
    'domain',
    'kind',
    'missing',
    'extra',
    'nested-extra',
    'clock-zero',
    'clock-overflow',
    'wall-negative-zero',
    'scope-digest',
    'scope-repository',
    'scope-worktree',
    'scope-phases',
    'sequence',
    'previous',
    'validity-zero',
    'validity-over',
    'wall-deadline',
    'ns-deadline',
    'ns-overflow',
  ])
    it(`refuses ${variant} approval before signing or exposing payload`, async () => {
      const codec = await api();
      const value = unsigned('approval');
      if (variant === 'domain') value.domain = 'devai.reconciliation.owner.v1/renewal';
      if (variant === 'kind') value.kind = 'renewal';
      if (variant === 'missing') delete value.scope;
      if (variant === 'extra') value.extra = 'PRIVATE_PAYLOAD_SENTINEL';
      const time = value.clock as RecordData,
        scoped = value.scope as RecordData;
      if (variant === 'nested-extra') time.extra = 'SECRET_CLOCK';
      if (variant === 'clock-zero') time.monotonic_ns = '0';
      if (variant === 'clock-overflow') time.monotonic_ns = '18446744073709551616';
      if (variant === 'wall-negative-zero') time.wall_ms = -0;
      if (variant === 'scope-digest') value.scope_sha256 = h('wrong');
      if (variant === 'scope-repository' || variant === 'scope-worktree') {
        scoped[variant === 'scope-repository' ? 'repository_id' : 'worktree_id'] = 'foreign';
        value.scope_sha256 = sha(canonical(scoped));
      }
      if (variant === 'scope-phases') scoped.allowed_phases = ['04', '03', '02', '01'];
      if (variant === 'sequence') value.sequence = 2;
      if (variant === 'previous') value.previous_grant_sha256 = h('prior');
      if (variant === 'validity-zero') value.validity_ms = 0;
      if (variant === 'validity-over') value.validity_ms = 900001;
      if (variant === 'wall-deadline') value.expires_wall_ms = 1792869300001;
      if (variant === 'ns-deadline') value.expires_monotonic_ns = '9007200154740993124';
      if (variant === 'ns-overflow') {
        time.monotonic_ns = '18446744073709551615';
        value.expires_monotonic_ns = '18446744073709551615';
      }
      expectCode(codec, () => codec.signReconciliationOwnerRecord(value, KEY), INVALID);
    });
  for (const variant of [
    'key-digest',
    'context',
    'anchor-context',
    'bindings-context',
    'head-context',
    'supplied-key',
    'cyclic-plan',
  ])
    it(`refuses issuer ${variant} binding mismatch`, async () => {
      const codec = await api();
      const value = unsigned('issuer');
      if (variant === 'key-digest') value.key_sha256 = h('wrong');
      if (variant === 'context') value.provision_context_sha256 = h('wrong');
      if (variant === 'anchor-context') (value.admission_anchor as RecordData).root = '/other';
      if (variant === 'bindings-context')
        (value.installation_bindings as RecordData).package_sha256 = h('other');
      if (variant === 'head-context') value.installed_at_head = 'b'.repeat(40);
      if (variant === 'cyclic-plan') value.provision_plan_sha256 = h('forbidden-cycle');
      expectCode(
        codec,
        () =>
          codec.signReconciliationOwnerRecord(value, variant === 'supplied-key' ? OTHER_KEY : KEY),
        INVALID,
      );
    });
  for (const phases of [['04', '02'], ['02', '02'], [], ['00'], ['01', '02', '03', '04', '04']])
    it(`refuses noncanonical renewal remaining phases ${phases.join(',')}`, async () => {
      const codec = await api();
      expectCode(
        codec,
        () =>
          codec.signReconciliationOwnerRecord(
            { ...unsigned('renewal'), remaining_phases: phases },
            KEY,
          ),
        INVALID,
      );
    });
  for (const kind of ['phase-intent', 'lease'] as const)
    for (const [phase, action, role] of [
      ['01', 'evidence reconcile materialize', 'inspector'],
      ['02', 'evidence reconcile materialize', 'inspector'],
      ['03', 'evidence reconcile stage-proof', 'inspector'],
      ['04', 'sense bootstrap-inventory', 'architect'],
    ] as const)
      it(`binds ${kind} phase${phase} exact action/role`, async () => {
        const codec = await api();
        const value: RecordData = { ...unsigned(kind), phase, action_id: action, initiator: role };
        if (kind === 'phase-intent')
          value.predecessor_completion_sha256 = phase === '01' ? null : h('completion');
        expect(codec.signReconciliationOwnerRecord(value, KEY)).toMatchObject({
          phase,
          action_id: action,
          initiator: role,
        });
        expectCode(
          codec,
          () =>
            codec.signReconciliationOwnerRecord(
              { ...value, initiator: role === 'architect' ? 'inspector' : 'architect' },
              KEY,
            ),
          INVALID,
        );
      });
  for (const kind of ['phase-intent', 'phase-completion'] as const)
    it(`refuses ${kind} predecessor nullness crossing phase01`, async () => {
      const codec = await api();
      expectCode(
        codec,
        () =>
          codec.signReconciliationOwnerRecord(
            { ...unsigned(kind), predecessor_completion_sha256: h('prior') },
            KEY,
          ),
        INVALID,
      );
      const value = { ...unsigned(kind), phase: '02', predecessor_completion_sha256: null };
      expectCode(codec, () => codec.signReconciliationOwnerRecord(value, KEY), INVALID);
    });
  it('requires unsigned input omit mac entirely and deadlines use exact declared validity', async () => {
    const codec = await api();
    expectCode(codec, () => codec.signReconciliationOwnerRecord(signed('approval'), KEY), INVALID);
    for (const kind of ['approval', 'renewal'] as const) {
      const value = {
        ...unsigned(kind),
        validity_ms: 1,
        expires_wall_ms: 1792868400001,
        expires_monotonic_ns: '9007199254741993123',
      };
      expect(codec.signReconciliationOwnerRecord(value, KEY)).toMatchObject({ validity_ms: 1 });
      expectCode(
        codec,
        () =>
          codec.signReconciliationOwnerRecord(
            { ...value, expires_monotonic_ns: '9007199254741993124' },
            KEY,
          ),
        INVALID,
      );
    }
  });
  for (const key of [
    KEY + '\n',
    KEY.slice(0, -1),
    KEY.replace('=', '=='),
    'A'.repeat(44),
    '_' + KEY.slice(1),
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    '',
    0,
    null,
  ])
    it(`refuses noncanonical key ${typeof key}`, async () => {
      const codec = await api();
      expectCode(
        codec,
        () => codec.signReconciliationOwnerRecord(unsigned('revocation'), key),
        INVALID,
      );
    });
  it('refuses base64 padding-bit aliases and key coercion without executing hooks', async () => {
    const codec = await api();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = KEY.at(-2) ?? '';
    const alias = KEY.slice(0, -2) + alphabet[alphabet.indexOf(last) + 1] + '=';
    expect(Buffer.from(alias, 'base64')).toEqual(KEY_BYTES);
    expectCode(
      codec,
      () => codec.signReconciliationOwnerRecord(unsigned('revocation'), alias),
      INVALID,
    );
    let touches = 0;
    expectCode(
      codec,
      () =>
        codec.signReconciliationOwnerRecord(unsigned('revocation'), {
          toString() {
            touches++;
            throw Error('SECRET_KEY');
          },
        }),
      INVALID,
    );
    expect(touches).toBe(0);
  });
});

describe('canonical byte ingress', () => {
  const reference = bytes(signed('revocation')).toString('utf8');
  for (const [name, text] of [
    ['no-LF', reference.slice(0, -1)],
    ['two-LF', reference + '\n'],
    ['leading-space', ' ' + reference],
    ['trailing-space', reference + ' '],
    ['BOM', '\ufeff' + reference],
    ['duplicate', reference.replace('{', '{"kind":"revocation",')],
    ['key-order', JSON.stringify(signed('revocation')) + '\n'],
    ['exponent', reference.replace('"sequence":2', '"sequence":2e0')],
    ['decimal', reference.replace('"sequence":2', '"sequence":2.0')],
    ['escaped-string', reference.replace('"revocation"', '"\\u0072evocation"')],
    ['trailing-object', reference + '{}'],
    ['negative-zero', reference.replace('"sequence":2', '"sequence":-0')],
  ] as const)
    it(`refuses ${name} JSON alias rather than normalizing accepted ingress`, async () => {
      const codec = await api();
      expectCode(
        codec,
        () => codec.decodeReconciliationOwnerRecord(Buffer.from(text)),
        name === 'negative-zero' ? INVALID : ENCODING,
      );
    });
  it('rejects invalid UTF8 and lone surrogates without parser causes or raw bytes', async () => {
    const codec = await api();
    for (const input of [
      Buffer.from([0xff]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.concat([bytes(signed('revocation')), Buffer.from([0xff])]),
    ])
      expectCode(codec, () => codec.decodeReconciliationOwnerRecord(input), ENCODING);
    expectCode(
      codec,
      () => codec.validateReconciliationOwnerRecord({ ...signed('lease'), hostname: '\ud800' }),
      INVALID,
    );
    expectCode(
      codec,
      () =>
        codec.decodeReconciliationOwnerRecord(
          Buffer.from(bytes({ ...signed('lease'), hostname: '\ud800' })),
        ),
      INVALID,
    );
  });
  it('accepts canonical nonASCII scalar UTF8 without escaping or Unicode normalization', async () => {
    const codec = await api();
    const value = { ...unsigned('lease'), hostname: 'fixture-é-😀-e\u0301' };
    const record = codec.signReconciliationOwnerRecord(value, KEY);
    expect(codec.decodeReconciliationOwnerRecord(bytes(record))).toEqual(record);
    expect(Buffer.from(codec.encodeReconciliationOwnerRecord(record))).toEqual(bytes(record));
  });
  for (const variant of [
    'proxy',
    'fake',
    'arraybuffer',
    'dataview',
    'uint16',
    'shared',
    'detached',
  ])
    it(`refuses ${variant} byte source without fake typed-array access`, async () => {
      const codec = await api();
      let touches = 0;
      let input: unknown = bytes(signed('revocation'));
      if (variant === 'proxy')
        input = new Proxy(new Uint8Array(bytes(signed('revocation'))), {
          get() {
            touches++;
            throw Error('SECRET_BYTE_PROXY');
          },
        });
      if (variant === 'fake') input = Object.create(Uint8Array.prototype);
      if (variant === 'arraybuffer') input = new ArrayBuffer(16);
      if (variant === 'dataview') input = new DataView(new ArrayBuffer(16));
      if (variant === 'uint16') input = new Uint16Array(16);
      if (variant === 'shared') input = new Uint8Array(new SharedArrayBuffer(16));
      if (variant === 'detached') {
        const arr = new Uint8Array(16);
        structuredClone(arr.buffer, { transfer: [arr.buffer] });
        input = arr;
      }
      expectCode(codec, () => codec.decodeReconciliationOwnerRecord(input), ENCODING);
      expect(touches).toBe(0);
    });
  it('copies subclass/subarray bytes through intrinsics without length/buffer/constructor/species/iterator traps', async () => {
    const codec = await api();
    let touches = 0;
    class HostileBytes extends Uint8Array {}
    const raw = bytes(signed('revocation'));
    const input = new HostileBytes(raw.length + 4);
    Uint8Array.prototype.set.call(input, raw, 2);
    const view = new Uint8Array(input.buffer, 2, raw.length);
    const subclassView = input.subarray(2, -2);
    for (const field of ['length', 'byteLength', 'byteOffset', 'buffer', 'constructor'])
      Object.defineProperty(view, field, {
        get() {
          touches++;
          throw Error('SECRET_BYTE_GETTER');
        },
      });
    Object.defineProperty(view, Symbol.iterator, {
      get() {
        touches++;
        throw Error('SECRET_BYTE_ITERATOR');
      },
    });
    Object.defineProperty(HostileBytes, Symbol.species, {
      get() {
        touches++;
        throw Error('SECRET_BYTE_SPECIES');
      },
    });
    expect(codec.decodeReconciliationOwnerRecord(view)).toEqual(signed('revocation'));
    expect(codec.decodeReconciliationOwnerRecord(subclassView)).toEqual(signed('revocation'));
    expect(touches).toBe(0);
  });
});

describe('descriptor-safe bounded record copies', () => {
  for (const variant of [
    'getter',
    'proxy',
    'nested-getter',
    'nested-proxy',
    'toJSON',
    'prototype',
    'symbol',
    'nonenumerable',
    'proto-name',
    'undefined',
    'function',
    'bigint',
    'nan',
    'fraction',
    'unsafe',
    'negative-zero',
    'array-hole',
    'array-extra',
    'array-prototype',
    'cycle',
  ])
    it(`refuses ${variant} data without traps or unbounded serialization`, async () => {
      const codec = await api();
      let touches = 0;
      let value: unknown = signed('approval');
      const data = value as RecordData;
      if (variant === 'getter')
        Object.defineProperty(data, 'mac', {
          enumerable: true,
          get() {
            touches++;
            throw Error('SECRET_GETTER');
          },
        });
      if (variant === 'proxy')
        value = new Proxy(data, {
          ownKeys() {
            touches++;
            throw Error('SECRET_PROXY');
          },
        });
      if (variant === 'nested-getter')
        Object.defineProperty(data.clock as object, 'wall_ms', {
          enumerable: true,
          get() {
            touches++;
            throw Error('SECRET_NESTED');
          },
        });
      if (variant === 'nested-proxy')
        data.clock = new Proxy(data.clock as RecordData, {
          ownKeys() {
            touches++;
            throw Error('SECRET_NESTED_PROXY');
          },
        });
      if (variant === 'toJSON')
        Object.defineProperty(data, 'toJSON', {
          enumerable: true,
          get() {
            touches++;
            throw Error('SECRET_TOJSON');
          },
        });
      if (variant === 'prototype')
        value = Object.assign(
          Object.create({
            toJSON() {
              touches++;
              throw Error('SECRET_PROTO');
            },
          }) as object,
          data,
        );
      if (variant === 'symbol')
        Object.defineProperty(data, Symbol('private'), {
          value: 'PRIVATE_PAYLOAD_SENTINEL',
          enumerable: true,
        });
      if (variant === 'proto-name')
        Object.defineProperty(data, '__proto__', {
          value: { PRIVATE_PAYLOAD_SENTINEL: true },
          enumerable: true,
        });
      if (variant === 'nonenumerable')
        Object.defineProperty(data, 'hidden', { value: 'PRIVATE_PAYLOAD_SENTINEL' });
      if (
        ['undefined', 'function', 'bigint', 'nan', 'fraction', 'unsafe', 'negative-zero'].includes(
          variant,
        )
      ) {
        const invalid: unknown =
          variant === 'undefined'
            ? undefined
            : variant === 'function'
              ? () => {
                  touches++;
                }
              : variant === 'bigint'
                ? 1n
                : variant === 'nan'
                  ? NaN
                  : variant === 'fraction'
                    ? 0.5
                    : variant === 'unsafe'
                      ? Number.MAX_SAFE_INTEGER + 1
                      : -0;
        Object.defineProperty(data, 'extra', { value: invalid, enumerable: true });
      }
      if (variant === 'cycle') data.extra = data;
      if (variant === 'array-hole') {
        const array = new Array<string>(4);
        array[0] = '01';
        (data.scope as RecordData).allowed_phases = array;
      }
      if (variant === 'array-extra') {
        const array = ['01', '02', '03', '04'];
        Object.defineProperty(array, 'extra', {
          get() {
            touches++;
            throw Error('SECRET_ARRAY');
          },
          enumerable: true,
        });
        (data.scope as RecordData).allowed_phases = array;
      }
      if (variant === 'array-prototype') {
        const array = ['01', '02', '03', '04'];
        Object.setPrototypeOf(array, {
          [Symbol.iterator]() {
            touches++;
            throw Error('SECRET_ITERATOR');
          },
        });
        (data.scope as RecordData).allowed_phases = array;
      }
      expectCode(codec, () => codec.validateReconciliationOwnerRecord(value), INVALID);
      expect(touches).toBe(0);
    });
  for (const variant of ['string', 'key', 'properties', 'array', 'depth', 'nodes', 'bytes'])
    it(`enforces ${variant} copy budget before schema`, async () => {
      const codec = await api();
      const value = signed('revocation');
      if (variant === 'string') value.extra = 'x'.repeat(262145);
      if (variant === 'key') value['x'.repeat(129)] = 'short';
      if (variant === 'properties')
        value.extra = Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['p' + i, 0]));
      if (variant === 'array') value.extra = Array.from({ length: 4097 }, () => 0);
      if (variant === 'depth') {
        let deep: Json = 0;
        for (let i = 0; i < 34; i++) deep = { nested: deep };
        value.extra = deep;
      }
      if (variant === 'nodes')
        value.extra = Array.from({ length: 5 }, () => Array.from({ length: 3500 }, () => 0));
      if (variant === 'bytes') value.extra = Array.from({ length: 8 }, () => 'x'.repeat(140000));
      expectCode(codec, () => codec.validateReconciliationOwnerRecord(value), LIMIT);
    });
  it('rejects oversized byte input before parsing and never serializes schema/parser/key causes', async () => {
    const codec = await api();
    expectCode(codec, () => codec.decodeReconciliationOwnerRecord(new Uint8Array(1048577)), LIMIT);
    expectCode(
      codec,
      () =>
        codec.decodeReconciliationOwnerRecord(Buffer.from('{"PRIVATE_PAYLOAD_SENTINEL":"' + KEY)),
      ENCODING,
    );
    expectCode(
      codec,
      () =>
        codec.signReconciliationOwnerRecord(
          { ...unsigned('issuer'), private_key_base64: 'PRIVATE_PAYLOAD_SENTINEL' },
          KEY,
        ),
      INVALID,
    );
  });
  it('allows null-prototype records and arrays without invoking iterators', async () => {
    const codec = await api();
    const value = signed('approval');
    const data = Object.assign(Object.create(null) as object, value);
    const phases = ['01', '02', '03', '04'];
    Object.setPrototypeOf(phases, null);
    (data as RecordData).scope = { ...scope(), allowed_phases: phases };
    expect(codec.validateReconciliationOwnerRecord(data)).toEqual(value);
  });
});

it('matches the separately generated Python stdlib fixed revocation byte/HMAC vector', async () => {
  const codec = await api();
  const record = codec.signReconciliationOwnerRecord(unsigned('revocation'), KEY);
  expect(record.mac).toBe('74f491ee2d51dc4e5532e48bd2db7392c16b76bf98bc0f6d5bcacf20e81566c1');
  const encoded = codec.encodeReconciliationOwnerRecord(record);
  expect(encoded.byteLength).toBe(834);
  expect(sha(encoded)).toBe('31ad4d18a68ce12c83f8e78c491459db1cbfa8681bcbf0822ed5567852dcb5bb');
});

for (const [kind, field, value] of [
  ['phase-completion', 'durability', 'indeterminate'],
  ['lease', 'pid', 0],
  ['lease', 'pid', 2147483648],
  ['lease', 'hostname', 'bad\nHOST'],
  ['renewal', 'sequence', 1],
  ['renewal', 'resumable_intent_sha256', undefined],
  ['revocation', 'previous_grant_sha256', null],
  ['revocation', 'sequence', 1],
  ['revocation', 'mac', 'A'.repeat(64)],
  ['revocation', 'mac', 'g'.repeat(64)],
] as const)
  it(`refuses closed ${kind}.${field} variant`, async () => {
    const codec = await api();
    const record = signed(kind);
    Object.defineProperty(record, field, { value, enumerable: true });
    expectCode(codec, () => codec.validateReconciliationOwnerRecord(record), INVALID);
  });

it('copies every nested record/array before freezing and never retains mutable source bytes', async () => {
  const codec = await api();
  const input = signed('approval');
  const copied = codec.validateReconciliationOwnerRecord(input);
  expect(copied).not.toBe(input);
  expect(copied.clock).not.toBe(input.clock);
  expect(copied.scope).not.toBe(input.scope);
  expect((copied.scope as RecordData).allowed_phases).not.toBe(
    (input.scope as RecordData).allowed_phases,
  );
  expect(Object.isFrozen(input.clock)).toBe(false);
  expect(Object.isFrozen(input.scope)).toBe(false);
  expect(Object.isFrozen((input.scope as RecordData).allowed_phases)).toBe(false);
  (input.clock as RecordData).wall_ms = 0;
  ((input.scope as RecordData).allowed_phases as Json[]).push('foreign');
  expect((copied.clock as RecordData).wall_ms).toBe(1792868400000);
  expect((copied.scope as RecordData).allowed_phases).toEqual(['01', '02', '03', '04']);
  const raw = bytes(signed('issuer'));
  const decoded = codec.decodeReconciliationOwnerRecord(raw);
  raw.fill(0);
  expect(decoded).toEqual(signed('issuer'));
});
for (const variant of ['string', 'key', 'properties', 'array', 'depth'])
  it(`does not misclassify at-limit ${variant} data as resource overflow`, async () => {
    const codec = await api();
    const value = signed('revocation');
    if (variant === 'string') value.extra = 'x'.repeat(262144);
    if (variant === 'key') value['x'.repeat(128)] = 0;
    if (variant === 'properties')
      value.extra = Object.fromEntries(Array.from({ length: 128 }, (_, i) => ['p' + i, 0]));
    if (variant === 'array') value.extra = Array.from({ length: 4096 }, () => 0);
    if (variant === 'depth') {
      let deep: Json = 0;
      for (let i = 0; i < 31; i++) deep = { nested: deep };
      value.extra = deep;
    }
    expectCode(codec, () => codec.validateReconciliationOwnerRecord(value), INVALID);
  });
