import { describe, expect, it } from 'vitest';
import {
  canonicalBytes,
  expectFailure,
  expectSuccess,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

type Plant = ReturnType<typeof makePolicyPlant>;
type Edit = (plant: Plant) => void;
const core = (plant: Plant) => plant.deps.immutableCore as Record<string, unknown>;
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('expected nonempty policy fixture');
  return item;
}
const extension = (plant: Plant) =>
  first(plant.deps.additiveExtensions as Record<string, unknown>[]);
const document = (plant: Plant) => plant.document as Record<string, unknown>;
const sourceCases: readonly [string, Edit][] = [
  [
    'missing core',
    (p) => {
      p.deps.immutableCore = null;
    },
  ],
  [
    'missing extensions',
    (p) => {
      p.deps.additiveExtensions = null;
    },
  ],
  [
    'core rules not an array',
    (p) => {
      core(p).rules = {};
    },
  ],
  [
    'wrong core identity',
    (p) => {
      core(p).policy_id = 'other-core';
    },
  ],
  [
    'invalid core version',
    (p) => {
      core(p).policy_version = '1.0';
    },
  ],
  [
    'core bytes not bytes',
    (p) => {
      core(p).canonical_source_bytes = [];
    },
  ],
  [
    'truncated core bytes',
    (p) => {
      core(p).canonical_source_bytes = (core(p).canonical_source_bytes as Uint8Array).slice(1);
    },
  ],
  [
    'modified core byte',
    (p) => {
      const bytes = Uint8Array.from(core(p).canonical_source_bytes as Uint8Array);
      bytes[0] = first(Array.from(bytes)) ^ 1;
      core(p).canonical_source_bytes = bytes;
    },
  ],
  [
    'compiled core rules diverge',
    (p) => {
      core(p).rules = [];
    },
  ],
  [
    'extension rules not an array',
    (p) => {
      extension(p).rules = {};
    },
  ],
  [
    'invalid extension version',
    (p) => {
      extension(p).extension_version = '01.0.0';
    },
  ],
  [
    'extension bytes not bytes',
    (p) => {
      extension(p).canonical_source_bytes = [];
    },
  ],
  [
    'truncated extension bytes',
    (p) => {
      extension(p).canonical_source_bytes = (
        extension(p).canonical_source_bytes as Uint8Array
      ).slice(1);
    },
  ],
  [
    'compiled extension rules diverge',
    (p) => {
      extension(p).rules = [];
    },
  ],
];

describe('authority policy source custody', () => {
  it.each(sourceCases)('refuses %s', async (_label, edit) => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    edit(plant);
    expectFailure(
      api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH',
    );
  });

  it.each([
    [
      'package version',
      (p: Plant) => {
        p.deps.expected_package = { ...(p.deps.expected_package as object), version: '99.0.0' };
      },
    ],
    [
      'package name',
      (p: Plant) => {
        p.deps.expected_package = { ...(p.deps.expected_package as object), name: 'other-package' };
      },
    ],
    [
      'constitution digest',
      (p: Plant) => {
        p.deps.expected_constitution = {
          ...(p.deps.expected_constitution as object),
          digest_sha256: 'f'.repeat(64),
        };
      },
    ],
    [
      'policy identity',
      (p: Plant) => {
        p.deps.expected_policy_id = 'other-policy';
      },
    ],
    [
      'source version',
      (p: Plant) => {
        document(p).source_policy = {
          ...(document(p).source_policy as object),
          policy_version: '2.0.0',
        };
      },
    ],
    [
      'extension identity',
      (p: Plant) => {
        const items = structuredClone(document(p).additive_extensions) as Record<string, unknown>[];
        first(items).extension_id = 'other-extension';
        document(p).additive_extensions = items;
      },
    ],
    [
      'extension version',
      (p: Plant) => {
        const items = structuredClone(document(p).additive_extensions) as Record<string, unknown>[];
        first(items).extension_version = '2.0.0';
        document(p).additive_extensions = items;
      },
    ],
  ] as const)('refuses a mismatched %s', async (_label, edit) => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    edit(plant);
    expectFailure(
      api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_BINDING_MISMATCH',
    );
  });

  it('accepts independently copied canonical source bytes and rule objects', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    plant.deps.immutableCore = structuredClone(plant.immutableCore);
    plant.deps.additiveExtensions = structuredClone(plant.additiveExtensions);
    const loaded = expectSuccess<{ resolved_rule_bytes: Uint8Array }>(
      api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
    );
    expect(loaded.resolved_rule_bytes).toEqual(canonicalBytes(document(plant).rules));
  });
});

describe('policy semantic and digest boundaries', () => {
  it.each([undefined, 'invalid', '2026-07-15T12:00:00.000Z', '2026-07-15T11:59:59.000Z'])(
    'refuses a shadow expiry not strictly after materialization: %s',
    async (expires_at) => {
      const plant = makePolicyPlant({ enforcement: { mode: 'shadow', shadow: { expires_at } } });
      expectFailure(
        (await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps),
        'refused',
        'AUTHORITY_POLICY_SEMANTIC_INVALID',
      );
    },
  );

  it('revalidates semantics of the document returned by schema validation', async () => {
    const plant = makePolicyPlant();
    plant.deps.validatePolicySchema = () => ({
      ok: true,
      value: { view: { ...document(plant), policy_version: 'invalid' } },
    });
    expectFailure(
      (await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_SEMANTIC_INVALID',
    );
  });

  it.each([undefined, {}, { view: null }])(
    'retains exact policy bytes when a schema result supplies no document: %j',
    async (value) => {
      const plant = makePolicyPlant();
      plant.deps.validatePolicySchema = () => ({ ok: true, value });
      const loaded = expectSuccess<{
        document: { raw: unknown; view: unknown; canonical_bytes: Uint8Array };
      }>((await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps));
      expect(loaded.document.raw).toBe(plant.document);
      expect(loaded.document.view).toBe(plant.document);
      expect(loaded.document.canonical_bytes).toEqual(canonicalBytes(plant.document));
    },
  );

  it.each(['resolved', 'extension', 'missing extension'])(
    'rejects an independent %s digest mismatch',
    async (kind) => {
      const plant = makePolicyPlant();
      if (kind === 'resolved') document(plant).resolved_digest_sha256 = 'f'.repeat(64);
      else if (kind === 'missing extension') document(plant).additive_extensions = [];
      else {
        const items = structuredClone(document(plant).additive_extensions) as Record<
          string,
          unknown
        >[];
        first(items).digest_sha256 = 'f'.repeat(64);
        document(plant).additive_extensions = items;
      }
      expectFailure(
        (await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps),
        'refused',
        'AUTHORITY_POLICY_DIGEST_MISMATCH',
      );
    },
  );

  it('rejects a source identity substitution with unchanged version and bytes', async () => {
    const plant = makePolicyPlant();
    document(plant).source_policy = {
      ...(document(plant).source_policy as object),
      policy_id: 'another-core',
    };
    expectFailure(
      (await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_BINDING_MISMATCH',
    );
  });
});
