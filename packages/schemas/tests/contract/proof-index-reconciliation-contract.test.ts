import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ROSTER as LIVE_ROSTER } from '../../src/roster.js';
import { readJson, schemaExample } from '../fixtures/governance-v15.js';

const NAME = 'proof-index-reconciliation-contract.schema.json';
const PUBLIC_RUNTIME_ADDITIONS = [
  'evidence-reconciliation-plan.schema.json',
  'reconciliation-owner-action.schema.json',
  'reconciliation-materialize-result.schema.json',
  'reconciliation-proof-index-result.schema.json',
  'reconciliation-inventory-result.schema.json',
];
// Preserve the exact historical population while separately checking promotion.
const ROSTER = LIVE_ROSTER.filter((name) => !PUBLIC_RUNTIME_ADDITIONS.includes(name));
const schema = readJson(`law/schemas/${NAME}`);
const ajv = new Ajv2020({ strict: true });
ajv.addKeyword({ keyword: 'schema_version', schemaType: 'string' });
const validate = ajv.compile(schema);

function altered(path: string, value: unknown, remove = false): unknown {
  const copy = schemaExample<Record<string, unknown>>(NAME);
  const segments = path.split('.');
  let target = copy;
  for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
  const leaf = segments.at(-1);
  if (leaf === undefined) throw new Error('missing mutation path');
  if (remove) Reflect.deleteProperty(target, leaf);
  else target[leaf] = value;
  return copy;
}

describe('source-only proof-index reconciliation reference shape', () => {
  it('compiles in strict mode and accepts its example without entering runtime ROSTER', () => {
    expect(validate(schemaExample(NAME)), JSON.stringify(validate.errors)).toBe(true);
    expect(ROSTER).toHaveLength(122);
    expect(LIVE_ROSTER).toHaveLength(127);
    expect(LIVE_ROSTER.filter((name) => PUBLIC_RUNTIME_ADDITIONS.includes(name)).sort()).toEqual(
      [...PUBLIC_RUNTIME_ADDITIONS].sort(),
    );
    expect(ROSTER as readonly string[]).not.toContain(NAME);
  });

  it.each([
    'schemaVersion',
    'contract_kind',
    'repository_id',
    'worktree_id',
    'proof_path',
    'actor',
    'approval',
    'sources',
    'before',
    'after',
    'effect',
    'actor.write_consent',
    'approval.phase_token_sha256',
    'sources.custody',
    'before.other_entries_sha256',
    'after.proof_entries',
    'effect.lock',
  ])('refuses missing %s', (path) => {
    expect(validate(altered(path, undefined, true))).toBe(false);
  });

  it.each([
    ['repository_id', '/physical/repository'],
    ['worktree_id', '../worktree'],
    ['proof_path', 'product/business.md'],
    ['actor.role', 'engineer'],
    ['actor.kind', 'machine'],
    ['actor.write_consent', false],
    ['approval.receipt_sha256', 'not-a-digest'],
    ['sources.head', 'main'],
    ['sources.custody', []],
    ['before.proof_entries', []],
    ['after.proof_entries', [{ mode: '120000', oid: 'b'.repeat(40), stage: 0 }]],
    ['after.proof_entries', [{ mode: '100644', oid: 'b'.repeat(40), stage: 4 }]],
    ['effect.entry', 'product/business.md'],
    ['effect.kind', 'filesystem-write'],
    ['effect.lock', 'caller-lock'],
    ['effect.publication', 'overwrite'],
    ['git_dir', '/physical/.git'],
    ['actor.argv', ['git', 'add', '.']],
    ['approval.ref', 'refs/heads/main'],
    ['sources.git_dir', '/physical/.git'],
    ['before.physical_index_path', '/physical/.git/index'],
    ['effect.output_paths', ['**']],
  ] as const)('refuses widened or malformed %s', (path, value) => {
    expect(validate(altered(path, value))).toBe(false);
  });

  it('closes custody and index-entry objects and rejects duplicate witnesses', () => {
    const custody = (
      schemaExample<Record<string, unknown>>(NAME).sources as {
        custody: Record<string, unknown>[];
      }
    ).custody[0];
    if (custody === undefined) throw new Error('missing custody example');
    expect(
      validate(altered('sources.custody', [{ ...custody, physical_path: '/tmp/archive' }])),
    ).toBe(false);
    expect(validate(altered('sources.custody', [{ ...custody, durable: false }]))).toBe(false);
    expect(validate(altered('sources.custody', [custody, custody]))).toBe(false);
    expect(
      validate(
        altered('after.proof_entries', [
          { mode: '100644', oid: 'b'.repeat(40), stage: 0, path: 'business.ts' },
        ]),
      ),
    ).toBe(false);
  });

  it('does not mistake structurally valid forged claims for a verified mutation capability', () => {
    // No trusted-host verifier exists at this contract-only stage. JSON-schema success
    // cannot prove ancestry, publication, durable custody, actual identity or real CAS.
    // Deliberately contradict the one-entry semantic invariant; shape still validates.
    const forged = altered('after.other_entries_sha256', 'f'.repeat(64));
    expect(validate(forged)).toBe(true);
    expect(schema.description).toContain('no runtime action or capability');
  });
});
