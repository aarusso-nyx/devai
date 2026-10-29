import Ajv2020 from 'ajv/dist/2020.js';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkSchema, getValidator, ROSTER as LIVE_ROSTER } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const NAME = 'reconciliation-owner.schema.json';
const PUBLIC_RUNTIME_ADDITIONS = [
  'evidence-reconciliation-plan.schema.json',
  'reconciliation-owner-action.schema.json',
  'reconciliation-materialize-result.schema.json',
  'reconciliation-proof-index-result.schema.json',
  'reconciliation-inventory-result.schema.json',
];
const SOURCE_RUNTIME_ADDITIONS = [
  'source-apply-manifest.schema.json',
  'source-apply-result.schema.json',
];
const B1_ROSTER = LIVE_ROSTER.filter((name) => !SOURCE_RUNTIME_ADDITIONS.includes(name));
const ROSTER = B1_ROSTER.filter((name) => !PUBLIC_RUNTIME_ADDITIONS.includes(name));
const CANDIDATE = resolve(
  ROOT,
  'docs/dev/operations/u1-b1-recovery-20261024/release-280/b1-design/owner-schema.candidate.json',
);
type Data = Record<string, unknown>;
const candidate = JSON.parse(readFileSync(CANDIDATE, 'utf8')) as { $defs: Record<string, Data> };
const kinds = [
  'issuer',
  'approval',
  'renewal',
  'revocation',
  'phase-intent',
  'phase-completion',
  'lease',
] as const;
const digest = 'a'.repeat(64);
const clock = {
  clock_source: 'node-uv-hrtime-ns-v1',
  boot_id: '11111111-2222-3333-4444-555555555555',
  monotonic_ns: '1000000000000',
  wall_ms: 1792868400000,
};
function fixture(kind: (typeof kinds)[number]): Data {
  const def = candidate.$defs[kind];
  if (def === undefined) throw new Error('missing reviewed variant');
  const required = def.required as string[];
  const properties = def.properties as Record<string, Data>;
  const data: Data = {};
  for (const key of required) {
    const rule = properties[key];
    if (rule === undefined) throw new Error('missing reviewed property');
    data[key] = Object.hasOwn(rule, 'const')
      ? structuredClone(rule.const)
      : rule.type === 'null'
        ? null
        : digest;
  }
  Object.assign(data, {
    repository_id: 'fixture-repository',
    worktree_id: 'fixture-worktree',
    clock: structuredClone(clock),
  });
  if (kind === 'issuer')
    Object.assign(data, {
      private_key_base64: Buffer.alloc(32, 7).toString('base64'),
      installed_at_head: 'a'.repeat(40),
      admission_anchor: {
        schemaVersion: '1.0.0',
        kind: 'reconciliation-admission-anchor',
        root: '/fixture/private',
        root_identity: { dev: '1', ino: '2', birthtime_ns: '3', uid: '501', mode: '0700' },
        seed_identity: {
          dev: '1',
          ino: '4',
          birthtime_ns: '3',
          uid: '501',
          mode: '0600',
          size_bytes: 8192,
          mtime_ns: '5',
          ctime_ns: '6',
        },
        seed_sha256: '3f6b742405bb199a11ed0952c9aa049285ef25dc69954e901d2e987cd15c4372',
      },
      installation_bindings: {
        package_sha256: digest,
        module_sha256: digest,
        registry_sha256: digest,
        constitution_sha256: digest,
        policy_sha256: digest,
      },
    });
  if (kind === 'approval')
    Object.assign(data, {
      scope: {
        repository_id: data.repository_id,
        worktree_id: data.worktree_id,
        host_identity_sha256: digest,
        binding_sha256: digest,
        plan_sha256: digest,
        source_manifest_sha256: digest,
        allowed_phases: ['01', '02', '03', '04'],
      },
    });
  if (kind === 'approval' || kind === 'renewal')
    Object.assign(data, {
      validity_ms: 900000,
      expires_wall_ms: clock.wall_ms + 900000,
      expires_monotonic_ns: '1900000000000',
    });
  if (kind === 'renewal')
    Object.assign(data, {
      sequence: 2,
      remaining_phases: ['01', '02', '03', '04'],
      resumable_intent_sha256: null,
    });
  if (kind === 'revocation') data.sequence = 2;
  if (kind === 'phase-intent' || kind === 'phase-completion' || kind === 'lease') data.phase = '01';
  if (kind === 'phase-intent' || kind === 'lease')
    Object.assign(data, { action_id: 'evidence reconcile materialize', initiator: 'inspector' });
  if (kind === 'phase-intent' || kind === 'phase-completion')
    data.predecessor_completion_sha256 = null;
  if (kind === 'lease') Object.assign(data, { pid: 123, hostname: 'fixture-host' });
  return data;
}
function registry() {
  return getValidator(NAME as Parameters<typeof getValidator>[0]);
}
function mutate(value: Data, path: string, replacement: unknown, remove = false): Data {
  const copy = structuredClone(value);
  const parts = path.split('.');
  let current = copy;
  for (const part of parts.slice(0, -1)) current = current[part] as Data;
  const key = parts.at(-1);
  if (key === undefined) throw new Error('empty mutation path');
  if (remove) Reflect.deleteProperty(current, key);
  else current[key] = replacement;
  return copy;
}

// Schema fixtures establish shape only. Their arbitrary MAC/digest witnesses do not
// authenticate origin, prove live deadlines, establish durability, or grant authority.
describe('closed reconciliation Owner record schema integration', () => {
  it('publishes exact reviewed canonical law bytes', () => {
    const file = resolve(ROOT, 'law/schemas', NAME);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file)).toEqual(readFileSync(CANDIDATE));
  });
  it('adds exactly one runtime roster member without promoting source-only references', () => {
    expect(ROSTER).toHaveLength(122);
    expect(B1_ROSTER).toHaveLength(127);
    expect(LIVE_ROSTER).toHaveLength(129);
    expect(LIVE_ROSTER.filter((name) => SOURCE_RUNTIME_ADDITIONS.includes(name)).sort()).toEqual(
      [...SOURCE_RUNTIME_ADDITIONS].sort(),
    );
    expect(LIVE_ROSTER.filter((name) => PUBLIC_RUNTIME_ADDITIONS.includes(name)).sort()).toEqual(
      [...PUBLIC_RUNTIME_ADDITIONS].sort(),
    );
    expect(ROSTER as readonly string[]).toContain(NAME);
    expect(ROSTER as readonly string[]).not.toContain(
      'proof-index-reconciliation-contract.schema.json',
    );
    expect(new Set(ROSTER).size).toBe(ROSTER.length);
  });
  it('meta-compiles reviewed candidate and preserves canonical closure', () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addKeyword({ keyword: 'schema_version', schemaType: 'string' });
    ajv.addSchema(
      JSON.parse(readFileSync(resolve(ROOT, 'law/schemas/common-defs.schema.json'), 'utf8')),
    );
    expect(ajv.validateSchema(candidate)).toBe(true);
    const validate = ajv.compile(candidate);
    for (const kind of kinds)
      expect(validate(fixture(kind)), JSON.stringify(validate.errors)).toBe(true);
    expect(checkSchema(NAME, candidate)).toEqual([]);
  });
  it.each(kinds)('validates %s using the actual fixed registry', (kind) => {
    const validate = registry();
    const value = fixture(kind);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, physical_path: '/tmp/private' })).toBe(false);
    const required = candidate.$defs[kind]?.required as string[];
    for (const key of required)
      expect(validate(mutate(value, key, undefined, true)), key).toBe(false);
    expect(validate({ ...value, kind: 'unknown' })).toBe(false);
    expect(validate({ ...value, domain: 'devai.reconciliation.owner.v1/unknown' })).toBe(false);
  });
  it.each(kinds)('closes nested and lexical fields for %s', (kind) => {
    const validate = registry();
    const value = fixture(kind);
    for (const [path, bad] of [
      ['clock.extra', true],
      ['clock.monotonic_ns', '0'],
      ['clock.monotonic_ns', '1\n'],
      ['clock.boot_id', 'not-a-boot'],
      ['repository_id', 'repo\n'],
      ['worktree_id', '/physical'],
      ['mac', 'A'.repeat(64)],
    ] as const)
      expect(validate(mutate(value, path, bad)), path).toBe(false);
  });
  it('closes issuer identities, seed bytes, bindings and private key wire shape', () => {
    const validate = registry();
    const value = fixture('issuer');
    for (const [path, bad] of [
      ['admission_anchor.extra', true],
      ['admission_anchor.root_identity.extra', true],
      ['admission_anchor.seed_identity.extra', true],
      ['admission_anchor.root_identity.mode', '0755'],
      ['admission_anchor.seed_identity.mode', '0644'],
      ['admission_anchor.seed_identity.size_bytes', 8193],
      ['admission_anchor.seed_sha256', 'b'.repeat(64)],
      ['installation_bindings.extra', true],
      ['private_key_base64', 'x'.repeat(44)],
      ['installed_at_head', 'a'.repeat(40) + '\n'],
    ] as const)
      expect(validate(mutate(value, path, bad)), path).toBe(false);
  });
  it('preserves original approval scope closure and signed validity bounds', () => {
    const validate = registry();
    const value = fixture('approval');
    for (const [path, bad] of [
      ['scope.extra', true],
      ['scope.allowed_phases', ['01']],
      ['validity_ms', 0],
      ['validity_ms', 900001],
      ['sequence', 2],
      ['previous_grant_sha256', digest],
      ['expires_wall_ms', Number.MAX_SAFE_INTEGER + 1],
    ] as const)
      expect(validate(mutate(value, path, bad)), path).toBe(false);
    expect(validate({ ...fixture('renewal'), sequence: 1 })).toBe(false);
    expect(validate({ ...fixture('renewal'), remaining_phases: ['01', '01'] })).toBe(false);
    expect(validate({ ...fixture('revocation'), resumable_intent_sha256: digest })).toBe(false);
  });
  it('binds phase action and initiator, with predecessor null only at phase01', () => {
    const validate = registry();
    for (const kind of ['phase-intent', 'lease'] as const)
      for (const phase of ['01', '02', '03', '04']) {
        const value: Data = {
          ...fixture(kind),
          phase,
          action_id:
            phase === '04'
              ? 'sense bootstrap-inventory'
              : phase === '03'
                ? 'evidence reconcile stage-proof'
                : 'evidence reconcile materialize',
          initiator: phase === '04' ? 'architect' : 'inspector',
        };
        if (kind === 'phase-intent')
          value.predecessor_completion_sha256 = phase === '01' ? null : digest;
        expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...value, initiator: 'owner' })).toBe(false);
        expect(validate({ ...value, action_id: 'evidence reconcile approve' })).toBe(false);
      }
    expect(
      validate({
        ...fixture('phase-completion'),
        phase: '02',
        predecessor_completion_sha256: null,
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture('phase-completion'),
        phase: '02',
        predecessor_completion_sha256: digest,
      }),
    ).toBe(true);
    expect(validate({ ...fixture('phase-completion'), durability: 'indeterminate' })).toBe(false);
  });
  it('does not mistake structurally valid forged witnesses for semantic capability', () => {
    const validate = registry();
    expect(
      validate({ ...fixture('approval'), scope_sha256: 'b'.repeat(64), expires_monotonic_ns: '1' }),
    ).toBe(true);
    expect(validate({ ...fixture('issuer'), key_sha256: 'b'.repeat(64) })).toBe(true);
    // These are intentional schema-only positives. The codec/host must refuse
    // wrong computable digests/deadlines and unauthenticated origin independently.
  });
  it('stages the actual complete law population with the real package copy script', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'devai-owner-schema-stage-'));
    try {
      const scripts = join(fixtureRoot, 'packages/schemas/scripts');
      mkdirSync(scripts, { recursive: true });
      cpSync(resolve(ROOT, 'law'), join(fixtureRoot, 'law'), { recursive: true });
      copyFileSync(
        resolve(ROOT, 'packages/schemas/scripts/copy-law.mjs'),
        join(scripts, 'copy-law.mjs'),
      );
      const result = spawnSync(process.execPath, [join(scripts, 'copy-law.mjs')], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const sourceNames = readdirSync(resolve(ROOT, 'law/schemas'))
        .filter((name) => name.endsWith('.schema.json'))
        .sort();
      expect(
        sourceNames.filter(
          (name) =>
            !PUBLIC_RUNTIME_ADDITIONS.includes(name) && !SOURCE_RUNTIME_ADDITIONS.includes(name),
        ),
      ).toHaveLength(135);
      expect(sourceNames).toHaveLength(142);
      expect(sourceNames.filter((name) => SOURCE_RUNTIME_ADDITIONS.includes(name)).sort()).toEqual(
        [...SOURCE_RUNTIME_ADDITIONS].sort(),
      );
      const output = join(fixtureRoot, 'packages/schemas/dist/schemas');
      expect(
        readdirSync(output)
          .filter((name) => name.endsWith('.schema.json'))
          .sort(),
      ).toEqual(sourceNames);
      for (const name of sourceNames)
        expect(readFileSync(join(output, name)), name).toEqual(
          readFileSync(resolve(ROOT, 'law/schemas', name)),
        );
      expect(existsSync(join(output, NAME))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
