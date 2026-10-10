// Issue #264: the adopter migration manifest is versioned, schema-valid, and covers every
// release above its baseline, so a release that changes adopter-facing configuration cannot
// ship without the entry init upgrade plans from.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRABLE_OWNED_POINTERS } from '../../src/services/adopter-policy-ownership.js';
import {
  compareVersions,
  loadAdopterMigrations,
  parseAdopterMigrations,
  plannedReleases,
  releasesInRange,
} from '../../src/services/adopter-migrations.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'law/policy/adopter-migrations.json'), 'utf8'),
) as Record<string, unknown>;
const manifest = loadAdopterMigrations();
const changes = manifest.releases.flatMap((release) => release.changes);
const decisionRecords = new Set(
  readdirSync(join(ROOT, 'law/adr'))
    .map((name) => /^(ADR-[A-Z]{3}-[0-9]{4})-/u.exec(name)?.[1])
    .filter((id): id is string => id !== undefined),
);

/**
 * Releases that changed no adopter-facing configuration, so the manifest holds no entry for them
 * (adopter-migrations.schema.json: an entry exists for every release that changed adopter-facing
 * configuration, and an entry needs at least one change). Each one is named with its reason;
 * init upgrade across one only restamps the bound version.
 */
const CONFIGURATION_NEUTRAL_RELEASES: ReadonlyMap<string, string> = new Map([
  [
    '2.2.0',
    'Behavior and diagnostics only (refusal envelopes, audit observe --previous, coverage report binding); no law, policy, schema or materialized adopter file changed since 2.1.0.',
  ],
]);

describe('#264: the adopter migration manifest', () => {
  it('validates against its schema with ascending releases and version-scoped change ids', () => {
    expect(manifest.baseline).toBe('1.6.0');
    expect(manifest.segments).toEqual([
      'constitution',
      'operational-law',
      'subprocess-effects',
      'adopter-policy',
      'authority',
      'host-adapters',
      'harness-ci',
    ]);
    expect(manifest.releases.map((release) => release.version)).toEqual([
      '1.7.0',
      '1.8.0',
      '1.9.0',
      '2.0.0',
      '2.1.0',
      '2.3.0',
      '2.3.1',
      '2.3.2',
      '2.4.0',
    ]);
    expect(manifest.releases.find((release) => release.version === '2.3.0')).toMatchObject({
      version: '2.3.0',
      status: 'released',
      date: '2026-10-08',
    });
    // #381, #383: the 2.3.1 rebinds are released.
    const released = manifest.releases.find((release) => release.version === '2.3.1');
    expect(released).toMatchObject({ version: '2.3.1', status: 'released', date: '2026-10-09' });
    expect(released?.changes.map((change) => change.id)).toEqual([
      'MIG-2.3.1-observation-workflow-pins',
      'MIG-2.3.1-subprocess-effects-pnpm-shapes',
    ]);
    // #390: the 2.3.2 observation install rebind is released.
    const previous = manifest.releases.find((release) => release.version === '2.3.2');
    expect(previous).toMatchObject({ version: '2.3.2', status: 'released' });
    expect(previous).toHaveProperty('date', '2026-10-10');
    expect(previous?.changes).toEqual([
      expect.objectContaining({
        id: 'MIG-2.3.2-observation-install-ignore-scripts',
        kind: 'rebind',
        issues: [390],
        segments: ['host-adapters'],
        files: [
          '.github/workflows/devai-main-observation.yml',
          '.devai/config/github-actions-host-adapter.json',
        ],
      }),
    ]);
    const latest = manifest.releases.at(-1);
    expect(latest).toMatchObject({ version: '2.4.0', status: 'released', date: '2026-10-10' });
    expect(latest?.changes).toEqual([
      expect.objectContaining({
        id: 'MIG-2.4.0-sensor-inputs-projection',
        kind: 'opt-in-capability',
        decision_records: ['ADR-SCR-0015', 'ADR-CFG-0002', 'ADR-AUT-0002'],
        segments: ['adopter-policy'],
        files: [
          '.devai/config/sensor-inputs.json',
          '.devai/config/adopter-policy-binding.json',
          'test-tasks.json',
        ],
      }),
      expect.objectContaining({
        id: 'MIG-2.4.0-declared-sensor-task-template',
        kind: 'rebind',
        decision_records: ['ADR-SCR-0015'],
        segments: ['subprocess-effects'],
        files: ['.devai/config/subprocess-effects.json'],
      }),
    ]);
  });

  it('has exactly one entry for every changelog release above the baseline that changed configuration', () => {
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/gmu)]
      .map((match) => ({ version: match[1] ?? '', date: match[2] ?? '' }))
      .filter((release) => compareVersions(release.version, manifest.baseline) > 0);
    expect(released.length).toBeGreaterThan(0);
    for (const release of released) {
      const entry = manifest.releases.find((candidate) => candidate.version === release.version);
      if (CONFIGURATION_NEUTRAL_RELEASES.has(release.version)) {
        expect(entry, `${release.version} is declared configuration-neutral`).toBeUndefined();
        continue;
      }
      expect(entry, release.version).toMatchObject({ status: 'released', date: release.date });
    }
    // A neutral declaration names a release the changelog records, never a future one.
    for (const version of CONFIGURATION_NEUTRAL_RELEASES.keys()) {
      expect(released.map((release) => release.version)).toContain(version);
    }
    for (const entry of manifest.releases.filter((candidate) => candidate.status === 'released')) {
      expect(released.map((release) => release.version)).toContain(entry.version);
    }
  });

  it('covers the installed package version', () => {
    const installed = resolveCliVersion();
    if (
      compareVersions(installed, manifest.baseline) > 0 &&
      !CONFIGURATION_NEUTRAL_RELEASES.has(installed)
    ) {
      expect(manifest.releases.map((release) => release.version)).toContain(installed);
    }
    // Across a neutral release no released entry is planned and init upgrade only restamps the
    // version.
    const released = (from: string, installedVersion: string) =>
      plannedReleases(manifest, from, installedVersion).filter(
        (release) => release.status === 'released',
      );
    for (const version of CONFIGURATION_NEUTRAL_RELEASES.keys()) {
      expect(released('2.1.0', version)).toEqual([]);
    }
    // #381, #383, #390: released rebinds are planned only in range, from below them up to them.
    const planned = (from: string, installedVersion: string) =>
      plannedReleases(manifest, from, installedVersion).map((release) => release.version);
    expect(planned('2.3.0', '2.3.0')).toEqual([]);
    expect(planned('2.3.0', '2.3.1')).toEqual(['2.3.1']);
    expect(planned('2.3.1', '2.3.1')).toEqual([]);
    expect(planned('2.3.0', '2.3.2')).toEqual(['2.3.1', '2.3.2']);
    expect(planned('2.3.1', '2.3.2')).toEqual(['2.3.2']);
    expect(planned('2.3.2', '2.3.2')).toEqual([]);
    expect(planned('2.3.2', '2.4.0')).toEqual(['2.4.0']);
    expect(planned('2.3.1', '2.4.0')).toEqual(['2.3.2', '2.4.0']);
    expect(planned('2.4.0', '2.4.0')).toEqual([]);
    expect(releasesInRange(manifest, '1.6.0', '1.9.0').map((release) => release.version)).toEqual([
      '1.7.0',
      '1.8.0',
      '1.9.0',
    ]);
    expect(releasesInRange(manifest, '1.9.0', '1.9.0')).toEqual([]);
  });

  it('plans an unreleased entry with the code that ships it, and a released one only in range (#291)', () => {
    const versions = (from: string, installed: string, source = manifest) =>
      plannedReleases(source, from, installed).map((release) => release.version);
    // While 2.1.0 was unreleased, its conversion shipped in the 2.0.0-stamped package, so a
    // plan at 2.0.0 recorded it.
    const unreleased = parseAdopterMigrations({
      ...MANIFEST,
      releases: (MANIFEST['releases'] as Record<string, unknown>[]).map((release) => {
        if (release['version'] !== '2.1.0') return release;
        const { date: _date, ...rest } = release;
        return { ...rest, status: 'unreleased' };
      }),
    });
    expect(versions('2.0.0', '2.0.0', unreleased)).toEqual(['2.1.0']);
    expect(versions('1.9.0', '2.0.0', unreleased)).toEqual(['2.0.0', '2.1.0']);
    expect(versions('1.6.0', '2.0.0', unreleased).slice(0, 4)).toEqual([
      '1.7.0',
      '1.8.0',
      '1.9.0',
      '2.0.0',
    ]);
    // Once released and installed, it is an ordinary entry, planned only from below it.
    expect(versions('2.1.0', '2.1.0')).toEqual([]);
    expect(versions('2.0.0', '2.1.0')).toEqual(['2.1.0']);
    expect(versions('2.0.0', '2.0.0')).toEqual([]);
  });

  it('cites only decision records that exist and names a canonical segment for each change', () => {
    for (const change of changes) {
      for (const id of change.decision_records) expect(decisionRecords, change.id).toContain(id);
      for (const segment of change.segments) expect(manifest.segments).toContain(segment);
    }
  });

  it('names exactly the retirable owned rows of the ownership matrix', () => {
    const retirement = changes.find((change) => change.kind === 'owned-key-retirement');
    expect(retirement?.decision_required).toBe(true);
    expect([...(retirement?.retired_pointers ?? [])].sort()).toEqual(
      [...RETIRABLE_OWNED_POINTERS].sort(),
    );
  });

  it('lists changed defaults that the shipped adopter defaults really carry', () => {
    for (const change of changes.filter((candidate) => candidate.kind === 'changed-default')) {
      const policy = change.default?.policy ?? '';
      const adopterDefault = join(ROOT, 'law/policy/adopter-defaults', policy);
      const source = existsSync(adopterDefault) ? adopterDefault : join(ROOT, 'law/policy', policy);
      const text = readFileSync(source, 'utf8');
      for (const item of change.default?.added ?? []) expect(text, change.id).toContain(item);
    }
  });

  it('names the constitution move the installed constitution text carries', () => {
    const constitution = readFileSync(join(ROOT, 'law/constitution.md'), 'utf8');
    for (const change of changes.filter((candidate) => candidate.kind === 'constitution')) {
      expect(constitution).toContain(`**Version:** ${change.constitution?.to ?? ''}`);
    }
  });

  it('refuses releases out of order and change ids outside their release', () => {
    const releases = MANIFEST['releases'] as Record<string, unknown>[];
    expect(() =>
      parseAdopterMigrations({ ...MANIFEST, releases: [...releases].reverse() }),
    ).toThrow(/ADOPTER_MIGRATIONS_INVALID:release/u);
    const [first, ...rest] = releases;
    const moved = {
      ...first,
      changes: [
        { ...((first?.['changes'] as Record<string, unknown>[])[0] ?? {}), id: 'MIG-9.9.9-moved' },
      ],
    };
    expect(() => parseAdopterMigrations({ ...MANIFEST, releases: [moved, ...rest] })).toThrow(
      /ADOPTER_MIGRATIONS_INVALID:change MIG-9.9.9-moved/u,
    );
    expect(() => parseAdopterMigrations({ ...MANIFEST, baseline: 'one' })).toThrow(
      /ADOPTER_MIGRATIONS_INVALID/u,
    );
  });
});
