// Inspector acceptance for ADR-CFG-0002: the bootstrap's reconciliation of
// project.json follows the same ownership matrix as `init bind --adopter-policy`
// (docs/adopters/install.md), so `init apply` and `init bind` never disagree about
// which keys are owned. The adopter-policy source is the only authority for the
// owned rows: the bootstrap neither retires nor rewrites them, never invents one
// beyond the schema-required project_type, stamps devai_version like every bind,
// and carries every adopter declaration outside the matrix unchanged.
import { describe, expect, it } from 'vitest';
import { reconcileProjectConfig } from '../../src/bootstrap/index.js';

type JsonObject = Record<string, unknown>;

const VERSION = '1.6.0';

/** The owned rows of the matrix, as projected by the adopter-policy bind. */
const OWNED = {
  project_type: 'framework',
  repo: { kind: 'library' },
  docs: {
    builder: 'docusaurus',
    output_dir: 'site/build',
    ia: { collapsed_sections: ['theory'], path_overrides: {} },
  },
  ci_economy: {
    profile: 'gate-staged',
    local_evidence: { required_jobs: ['unit'], max_age_hours: 24 },
    attested_rc: {
      profile: 'rc',
      transport: 'protected-tag-v1',
      tag_prefix: 'devai-local-evidence/',
      binding: 'exact-tree',
      required_check: 'verified-local-rc',
      failure_mode: 'fail-closed',
      local_only_nodes: ['test:mutation'],
    },
  },
} as const;

/** Adopter declarations: keys the matrix does not name. */
const DECLARATIONS = {
  name: 'Fixture Adopter',
  adopted_at: '2026-01-02T03:04:05Z',
  invariant_filters: { include_tags: ['core'], exclude_tags: ['legacy'] },
  feature_flags: { adopter_owned_toggle: true, other_toggle: false },
  governance_tracking: {
    adapter: 'github-issues',
    config: '.devai/config/github-issues-tracking.json',
  },
  future_schema_key: { admitted: 'later' },
} as const;

const OWNED_ROWS = ['repo', 'docs', 'ci_economy'] as const;

function bound(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    ...OWNED,
    authority_enforcement: { mode: 'cli-only' },
    profile: 'tier2',
    constitution: { version: '1.0.1', sha256: 'c'.repeat(64) },
    ...DECLARATIONS,
    devai_version: '1.5.0',
    ...overrides,
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('reconcileProjectConfig: owned rows belong to the adopter-policy bind', () => {
  it('carries every owned row the bind projected through reconciliation unchanged', () => {
    const current = bound();

    const reconciled = reconcileProjectConfig(current, { version: VERSION });

    for (const key of ['project_type', ...OWNED_ROWS]) {
      expect(JSON.stringify(reconciled[key]), key).toBe(JSON.stringify(current[key]));
    }
  });

  it('does not reintroduce an owned row the bind retired', () => {
    const retired = Object.fromEntries(
      Object.entries(bound()).filter(([key]) => !(OWNED_ROWS as readonly string[]).includes(key)),
    );

    const reconciled = reconcileProjectConfig(retired, { version: VERSION });

    for (const key of OWNED_ROWS) expect(reconciled, key).not.toHaveProperty(key);
  });

  it('does not reintroduce a nested row the bind retired on its own', () => {
    const current = bound({
      docs: { builder: 'docusaurus' },
      ci_economy: { profile: 'full', local_evidence: { required_jobs: ['unit'] } },
    });

    const reconciled = reconcileProjectConfig(current, { version: VERSION });

    expect(reconciled['docs']).toStrictEqual({ builder: 'docusaurus' });
    expect(reconciled['ci_economy']).toStrictEqual({
      profile: 'full',
      local_evidence: { required_jobs: ['unit'] },
    });
  });

  it('invents no owned row on a fresh project beyond the schema-required project_type', () => {
    const reconciled = reconcileProjectConfig({}, { version: VERSION });

    expect(reconciled['project_type']).toBe('runtime-host');
    for (const key of OWNED_ROWS) expect(reconciled, key).not.toHaveProperty(key);
  });

  it('stamps /devai_version exactly as every bind does', () => {
    const reconciled = reconcileProjectConfig(bound(), { version: VERSION });

    expect(reconciled['devai_version']).toBe(VERSION);
  });
});

describe('reconcileProjectConfig: adopter declarations outside the matrix survive', () => {
  it('carries every declaration through reconciliation byte for byte', () => {
    const current = bound();

    const reconciled = reconcileProjectConfig(current, { version: VERSION, profile: 'tier3' });

    for (const [key, value] of Object.entries(DECLARATIONS)) {
      expect(JSON.stringify(reconciled[key]), key).toBe(JSON.stringify(value));
    }
  });
});

describe('reconcileProjectConfig: the bootstrap and the bind agree on the bytes', () => {
  it('is idempotent on its own output, so a second init apply is a no-op', () => {
    const once = serialize(reconcileProjectConfig(bound(), { version: VERSION }));
    const twice = serialize(
      reconcileProjectConfig(JSON.parse(once) as JsonObject, { version: VERSION }),
    );

    expect(twice).toBe(once);
  });

  it('leaves a current bound projection byte-identical when nothing it manages changes', () => {
    const settled = serialize(reconcileProjectConfig(bound(), { version: VERSION }));

    const again = serialize(
      reconcileProjectConfig(JSON.parse(settled) as JsonObject, {
        version: VERSION,
        profile: 'tier2',
        constitution: { version: '1.0.1', sha256: 'c'.repeat(64) },
      }),
    );

    expect(again).toBe(settled);
  });
});
