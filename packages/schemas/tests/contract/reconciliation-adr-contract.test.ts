import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { resolveAdrFixture, type AdrRecordFixture } from '../fixtures/adr-v3.js';
import { ROOT, canonicalSha256, readJson, sha256 } from '../fixtures/governance-v15.js';

const ADR = 'ADR-EVI-0007';
const CI_ADR = 'ADR-CHK-0010';
const DOCUMENTATION_ADR = 'ADR-AUT-0010';
const documentationFile = 'ADR-AUT-0010-exact-documentation-implementation.md';
const documentationSubjects = [
  'law/constitution.md',
  'law/schemas/adopter-policy.schema.json',
  'packages/authority/src/documentation-implementation.ts',
  'packages/authority/src/runtime/policy-loader.ts',
  'packages/authority/src/runtime/documentation-context.ts',
  'scripts/check-commit-range.mjs',
  'tests/contract/commit-range-registry-generated.contract.test.ts',
  'docs/dev/operations/remote-preflight-contract.md',
  'packages/cli/src/services/adopter-policy-binding.ts',
  'packages/cli/src/services/write-scope/index.ts',
  'packages/spec/src/translation-validation/path-authority.ts',
];
const RELEASE_ADR = 'ADR-REL-0036';
const releaseFile = 'ADR-REL-0036-devai-rc-coverage-time-budget.md';
const releaseSubjects = [
  'scripts/process/release-prerequisites.mjs',
  'docs/dev/operations/process-simplification-rollout.md',
];
const ciFile = 'ADR-CHK-0010-required-native-apfs-qualification.md';
const GIT_ADR = 'ADR-CHK-0011';
const gitFile = 'ADR-CHK-0011-linux-partition-git-identity.md';
const gitSubjects = [
  '.github/workflows/pull-request-checks.yml',
  'scripts/check-workflows.mjs',
  'scripts/aggregate-gate-partitions.mjs',
  'scripts/process/summarize-check-report.mjs',
  'scripts/process/ci-partition/integrated.mjs',
  'scripts/process/ci-partition/verified-buffer.mjs',
  'scripts/process/ci-partition/bounded-process.mjs',
  'scripts/process/ci-partition/guards.mjs',
  'scripts/process/ci-partition/git-signing-key.asc',
  'tests/contract/ci-git-installer-inspector.contract.test.ts',
  'tests/contract/aggregate-gate-partitions.contract.test.ts',
  'tests/contract/pull-request-workflow.contract.test.ts',
  'packages/sensors/tests/unit/alignment-partition-jobs.test.ts',
  'docs/dev/operations/remote-preflight-contract.md',
  'docs/dev/operations/workflows/pull-request-checks.md',
];
const ciSubjects = [
  '.github/workflows/pull-request-checks.yml',
  'scripts/check-workflows.mjs',
  'scripts/run-native-apfs-tests.mjs',
  'packages/sensors/src/harness/workflow-parser.ts',
  'packages/cli/src/commands/check/ci-economy.ts',
  'docs/adopters/ci-economy.md',
];
const file = 'law/adr/ADR-EVI-0007-owner-approved-merge-reconciliation.md';
const subjects = [
  'law/policy/action-registry.json/evidence-reconcile',
  'law/policy/action-registry.json/sense-bootstrap-inventory',
  'packages/authority/src/boundaries/reconciliation-resources.ts',
  'packages/authority/src/boundaries/reconciliation-host.ts',
  'packages/authority/src/boundaries/proof-index-authority.ts',
  'packages/cli/src/commands/evidence/reconcile.ts',
  'packages/cli/src/commands/sense/bootstrap-inventory.ts',
];
const historicalPath = 'packages/schemas/tests/fixtures/adr-pre-280-ratification.json';
const historicalRaw = readFileSync(resolve(ROOT, historicalPath), 'utf8');
const historical = JSON.parse(historicalRaw) as { records: AdrRecordFixture[] };
const source = readFileSync(resolve(ROOT, file), 'utf8');
const metadata = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(source)?.[1] ?? '') as Record<
  string,
  unknown
>;
const policy = readJson<{
  body: { required_sections: string[] };
  exception_catalog: {
    catalog_digest_sha256: string;
    entries: {
      path: string;
      sha256: string;
      disposition: string;
      legacy_record?: {
        reference: string;
        title: string;
        status: AdrRecordFixture['status'];
        date: string | null;
        supersedes: string[];
        affected_rules: string[];
      };
    }[];
  };
}>('law/policy/adr-validation.json');
const adrRoot = resolve(ROOT, 'law/adr');
const projectionFile = 'ADR-CHK-0012-verified-registry-projection-authorship.md';
const sourceAdrFile = 'ADR-AUT-0009-exact-source-file-application.md';
const currentPaths = readdirSync(adrRoot)
  .filter((name) => name.endsWith('.md'))
  .sort();
const paths = currentPaths.filter(
  (name) => name !== projectionFile && name !== sourceAdrFile && name !== documentationFile,
);
const readRecord = (name: string): AdrRecordFixture[] => {
  const path = resolve(adrRoot, name);
  const exception = policy.exception_catalog.entries.find((entry) => entry.path === name);
  if (exception?.disposition === 'non-record') return [];
  if (exception?.legacy_record) {
    const { reference, title, status, date, supersedes, affected_rules } = exception.legacy_record;
    return [
      {
        file: relative(ROOT, path),
        adr_id: reference,
        format: 'legacy-catalog',
        title,
        status,
        date,
        supersedes,
        affected_rules,
      },
    ];
  }
  const text = readFileSync(path, 'utf8');
  const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '') as Record<string, unknown>;
  return [
    {
      file: relative(ROOT, path),
      adr_id: String(fm.id),
      title: String(fm.title),
      status: fm.status as AdrRecordFixture['status'],
      date: fm.date as string | null,
      format: 'v2',
      supersedes: fm.supersedes as string[],
      affected_rules: fm.affected_rules as string[],
    },
  ];
};
const records = paths.flatMap(readRecord);
const prior = historical.records.map((record): AdrRecordFixture => ({
  ...record,
  status: ['ADR-GOV-0027', 'ADR-AUT-0008'].includes(record.adr_id) ? 'accepted' : record.status,
}));
const ciPaths = paths.filter((path) => path !== releaseFile);
const ciRecords = records.filter((record) => record.adr_id !== RELEASE_ADR);
const preGitPaths = ciPaths.filter((path) => path !== gitFile);
const preGitRecords = ciRecords.filter((record) => record.adr_id !== GIT_ADR);
const reconciliationPaths = preGitPaths.filter((path) => path !== ciFile);
const reconciliationRecords = preGitRecords.filter((record) => record.adr_id !== CI_ADR);

describe('ADR-EVI-0007 bounded authoring contract', () => {
  it('keeps both proposals ineffective when resolved together', () => {
    const proposals = [projectionFile, sourceAdrFile].map((name): AdrRecordFixture => {
      const text = readFileSync(resolve(adrRoot, name), 'utf8');
      const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '') as Record<
        string,
        unknown
      >;
      return {
        file: `law/adr/${name}`,
        adr_id: String(fm.id),
        title: String(fm.title),
        status: 'proposed',
        date: fm.date as string | null,
        format: 'v2',
        supersedes: fm.supersedes as string[],
        affected_rules: fm.affected_rules as string[],
      };
    });
    const before = resolveAdrFixture(records, paths.length);
    const after = resolveAdrFixture([...records, ...proposals], currentPaths.length);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.subject_authorities).toEqual(before.subject_authorities);
    expect(after.effective_authorities).toEqual(before.effective_authorities);
  });
  it('accounts separately for the proposed registry projection record without changing authority', () => {
    expect(currentPaths).toHaveLength(paths.length + 3);
    expect(currentPaths.filter((name) => name === projectionFile)).toEqual([projectionFile]);
    const text = readFileSync(resolve(adrRoot, projectionFile), 'utf8');
    const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '') as Record<
      string,
      unknown
    >;
    expect(fm).toMatchObject({
      id: 'ADR-CHK-0012',
      status: 'accepted',
      authority: 'Architect',
      supersedes: ['ADR-CHK-0009'],
    });
    const projection: AdrRecordFixture = {
      file: `law/adr/${projectionFile}`,
      adr_id: String(fm.id),
      title: String(fm.title),
      status: 'proposed',
      date: fm.date as string | null,
      format: 'v2',
      supersedes: fm.supersedes as string[],
      affected_rules: fm.affected_rules as string[],
    };
    const before = resolveAdrFixture(records, paths.length);
    const after = resolveAdrFixture([...records, projection], paths.length + 1);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.adrs.filter((record) => record.adr_id !== 'ADR-CHK-0012')).toEqual(before.adrs);
    expect(after.adrs.find((record) => record.adr_id === 'ADR-CHK-0012')).toMatchObject({
      effective: false,
      effective_affected_rules: [],
    });
    expect(after.subject_authorities).toEqual(before.subject_authorities);
    expect(after.effective_authorities).toEqual(before.effective_authorities);
  });
  it('accounts separately for the proposed source application record without granting authority', () => {
    expect(currentPaths).toHaveLength(paths.length + 3);
    expect(currentPaths.filter((name) => name === sourceAdrFile)).toEqual([sourceAdrFile]);
    const text = readFileSync(resolve(adrRoot, sourceAdrFile), 'utf8');
    const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '') as Record<
      string,
      unknown
    >;
    expect(fm).toMatchObject({
      id: 'ADR-AUT-0009',
      status: 'accepted',
      authority: 'Architect',
      supersedes: [],
    });
    const sourceRecord: AdrRecordFixture = {
      file: `law/adr/${sourceAdrFile}`,
      adr_id: String(fm.id),
      title: String(fm.title),
      status: 'proposed',
      date: fm.date as string | null,
      format: 'v2',
      supersedes: fm.supersedes as string[],
      affected_rules: fm.affected_rules as string[],
    };
    const before = resolveAdrFixture(records, paths.length);
    const after = resolveAdrFixture([...records, sourceRecord], paths.length + 1);
    expect(after.ok).toBe(true);
    expect(after.adrs.filter((record) => record.adr_id !== 'ADR-AUT-0009')).toEqual(before.adrs);
    expect(after.adrs.find((record) => record.adr_id === 'ADR-AUT-0009')).toMatchObject({
      effective: false,
      effective_affected_rules: [],
    });
    expect(after.subject_authorities).toEqual(before.subject_authorities);
    expect(after.effective_authorities).toEqual(before.effective_authorities);
  });
  it('resolves both accepted records as effective current authority', () => {
    const additions = [projectionFile, sourceAdrFile].map((name): AdrRecordFixture => {
      const text = readFileSync(resolve(adrRoot, name), 'utf8');
      const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '') as Record<
        string,
        unknown
      >;
      expect(fm.status).toBe('accepted');
      return {
        file: `law/adr/${name}`,
        adr_id: String(fm.id),
        title: String(fm.title),
        status: 'accepted',
        date: fm.date as string | null,
        format: 'v2',
        supersedes: fm.supersedes as string[],
        affected_rules: fm.affected_rules as string[],
      };
    });
    const after = resolveAdrFixture([...records, ...additions], currentPaths.length);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    for (const id of ['ADR-CHK-0012', 'ADR-AUT-0009']) {
      expect(after.adrs.find((record) => record.adr_id === id)).toMatchObject({ effective: true });
      expect(after.effective_authorities).toContain(id);
    }
  });
  it('validates accepted frontmatter, required body sections and exact non-superseding subjects', () => {
    expect(getValidator('adr-v2.schema.json')(metadata)).toBe(true);
    expect(metadata).toMatchObject({
      id: ADR,
      status: 'accepted',
      authority: 'Architect',
      date: '2026-10-24',
      supersedes: [],
      affected_rules: subjects,
    });
    expect(metadata.inspector_acceptance).toHaveLength(9);
    for (const section of policy.body.required_sections)
      expect(source).toMatch(new RegExp(`^## ${section}$`, 'mu'));
    expect(new Set(subjects).size).toBe(subjects.length);
    for (const subject of subjects)
      expect(prior.flatMap((record) => record.affected_rules)).not.toContain(subject);
    expect(subjects).not.toContain('law/policy/action-registry.json');
  });

  it('adds exactly one record beyond the protected133 population and only the approved two ratifications', () => {
    expect(sha256(historicalRaw)).toBe(
      '05c776122fd5e4a939f446b5343943db03ef51a6e0051deaaa2099797f75fc0e',
    );
    expect(historical.records).toHaveLength(133);
    expect(reconciliationPaths).toHaveLength(135);
    expect(reconciliationRecords).toHaveLength(134);
    expect(reconciliationRecords.filter((record) => record.adr_id !== ADR)).toEqual(prior);
    expect(reconciliationRecords.filter((record) => record.adr_id === ADR)).toHaveLength(1);
    expect(preGitPaths).toHaveLength(136);
    expect(preGitRecords).toHaveLength(135);
    expect(ciPaths).toHaveLength(137);
    expect(ciRecords).toHaveLength(136);
    expect(paths).toHaveLength(138);
    expect(records).toHaveLength(137);
    expect(preGitRecords.filter((record) => record.adr_id === CI_ADR)).toEqual([
      {
        file: `law/adr/${ciFile}`,
        adr_id: CI_ADR,
        format: 'v2',
        title: 'Required native APFS qualification supplements the two Linux check partitions',
        status: 'accepted',
        date: '2026-10-25',
        supersedes: [],
        affected_rules: ciSubjects,
      },
    ]);
  });

  it('preserves every older accepted ADR byte against the frozen entry-preservation manifest', () => {
    const manifestRaw = readFileSync(
      resolve(
        ROOT,
        'docs/dev/operations/u1-b1-recovery-20261024/authority-policy-preview-approval/p1-implementation/entry-preservation.json',
      ),
      'utf8',
    );
    expect(sha256(manifestRaw)).toBe(
      'c9797b07c2f7b91a357490d1ddaa31bdba3353dbfa6071ec5e4e8715a30f0306',
    );
    const manifest = JSON.parse(manifestRaw) as {
      protected_sources: { path: string; sha256: string }[];
    };
    const accepted = historical.records.filter((record) => record.status === 'accepted');
    expect(accepted).toHaveLength(129);
    for (const record of accepted) {
      const original = manifest.protected_sources.find((entry) => entry.path === record.file);
      expect(original, record.file).toBeDefined();
      expect(sha256(readFileSync(resolve(ROOT, record.file))), record.file).toBe(original?.sha256);
    }
  });

  it('adds only seven unique subject authorities without changing any prior authority lineage', () => {
    const before = resolveAdrFixture(prior, 134);
    const after = resolveAdrFixture(reconciliationRecords, reconciliationPaths.length);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.adrs.filter((record) => record.adr_id !== ADR)).toEqual(before.adrs);
    expect(after.subject_authorities.filter((row) => !subjects.includes(row.subject))).toEqual(
      before.subject_authorities,
    );
    expect(after.subject_authorities.filter((row) => subjects.includes(row.subject))).toEqual(
      [...subjects]
        .sort()
        .map((subject) => ({ subject, lineage_members: [ADR], effective_head: ADR })),
    );
    expect(after.subject_authorities.length).toBe(before.subject_authorities.length + 7);
    expect(after.effective_authorities).toEqual([...before.effective_authorities, ADR].sort());
  });

  it('accounts separately for exact native qualification without changing prior subject lineages', () => {
    const before = resolveAdrFixture(reconciliationRecords, reconciliationPaths.length);
    const after = resolveAdrFixture(preGitRecords, preGitPaths.length);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.adrs.filter((record) => record.adr_id !== CI_ADR)).toEqual(before.adrs);
    expect(
      after.subject_authorities.filter((row) => !row.lineage_members.includes(CI_ADR)),
    ).toEqual(before.subject_authorities);
    expect(after.subject_authorities.filter((row) => row.lineage_members.includes(CI_ADR))).toEqual(
      [...ciSubjects]
        .sort()
        .map((subject) => ({ subject, lineage_members: [CI_ADR], effective_head: CI_ADR })),
    );
    expect(after.effective_authorities).toEqual([...before.effective_authorities, CI_ADR].sort());
  });

  it('accounts for the proposed Git record without granting authority or altering prior lineages', () => {
    expect(ciPaths).toHaveLength(137);
    expect(ciRecords).toHaveLength(136);
    expect(records.filter((record) => record.adr_id === GIT_ADR)).toEqual([
      {
        file: `law/adr/${gitFile}`,
        adr_id: GIT_ADR,
        format: 'v2',
        title: 'Bind Linux partition plans to the manifest Git version',
        status: 'proposed',
        date: '2026-10-27',
        supersedes: [],
        affected_rules: gitSubjects,
      },
    ]);
    const before = resolveAdrFixture(preGitRecords, preGitPaths.length);
    const after = resolveAdrFixture(ciRecords, ciPaths.length);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.adrs.filter((record) => record.adr_id !== GIT_ADR)).toEqual(before.adrs);
    expect(after.adrs.find((record) => record.adr_id === GIT_ADR)).toMatchObject({
      effective: false,
      effective_affected_rules: [],
    });
    expect(after.subject_authorities).toEqual(before.subject_authorities);
    expect(after.effective_authorities).toEqual(before.effective_authorities);
  });

  it('accounts separately for the RC coverage budget record and its exact subject authorities', () => {
    expect(records.filter((record) => record.adr_id === RELEASE_ADR)).toEqual([
      {
        file: `law/adr/${releaseFile}`,
        adr_id: RELEASE_ADR,
        format: 'v2',
        title: 'Bound DEVAI RC coverage execution to 45 minutes',
        status: 'accepted',
        date: '2026-10-28',
        supersedes: [],
        affected_rules: releaseSubjects,
      },
    ]);
    const before = resolveAdrFixture(ciRecords, ciPaths.length);
    const after = resolveAdrFixture(records, paths.length);
    expect(after.ok).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.adrs.filter((record) => record.adr_id !== RELEASE_ADR)).toEqual(before.adrs);
    expect(
      after.subject_authorities.filter((row) => !row.lineage_members.includes(RELEASE_ADR)),
    ).toEqual(before.subject_authorities);
    expect(
      after.subject_authorities.filter((row) => row.lineage_members.includes(RELEASE_ADR)),
    ).toEqual(
      [...releaseSubjects].sort().map((subject) => ({
        subject,
        lineage_members: [RELEASE_ADR],
        effective_head: RELEASE_ADR,
      })),
    );
    expect(after.effective_authorities).toEqual(
      [...before.effective_authorities, RELEASE_ADR].sort(),
    );
  });

  it('repins only the current README exception bytes and retains explicit unqualified runtime boundaries', () => {
    const entry = policy.exception_catalog.entries.find((row) => row.path === 'README.md');
    expect(entry?.sha256).toBe(sha256(readFileSync(resolve(adrRoot, 'README.md'))));
    expect(canonicalSha256(policy.exception_catalog.entries)).toBe(
      policy.exception_catalog.catalog_digest_sha256,
    );
    for (const text of [
      'It does not report implementation or independent',
      'qualification.',
      'permits no DETRAN operation',
      'general effect-authorization ledger remains unchanged',
      'immutable SQLite',
      'remains a candidate',
      'not publication',
      'shape or pure-codec test does not',
    ])
      expect(source).toContain(text);
  });
  it('extends the current provenance lineage with exact documentation authority', () => {
    const current = [...records, ...readRecord(projectionFile), ...readRecord(sourceAdrFile)];
    const added = readRecord(documentationFile);
    expect(added).toEqual([
      {
        file: `law/adr/${documentationFile}`,
        adr_id: DOCUMENTATION_ADR,
        format: 'v2',
        title: 'Exact documentation implementation core specialization',
        status: 'accepted',
        date: '2026-10-30',
        supersedes: ['ADR-CHK-0012'],
        affected_rules: documentationSubjects,
      },
    ]);
    const before = resolveAdrFixture(current, currentPaths.length - 1);
    const after = resolveAdrFixture([...current, ...added], currentPaths.length);
    expect(before.ok).toBe(true);
    expect(after.ok, JSON.stringify(after.errors)).toBe(true);
    expect(before.adrs.find((row) => row.adr_id === 'ADR-CHK-0012')).toMatchObject({
      effective: true,
    });
    expect(after.adrs.filter((row) => row.adr_id !== DOCUMENTATION_ADR)).toEqual(
      before.adrs.map((row) =>
        row.adr_id === 'ADR-CHK-0012'
          ? { ...row, effective: false, effective_affected_rules: [] }
          : row,
      ),
    );
    expect(after.adrs.find((row) => row.adr_id === DOCUMENTATION_ADR)).toMatchObject({
      effective: true,
      effective_affected_rules: [
        ...new Set([
          ...documentationSubjects,
          'tests/contract/commit-range-registry-generated.contract.test.ts',
          'docs/dev/operations/remote-preflight-contract.md',
        ]),
      ].sort(),
    });
    expect(after.effective_authorities).toEqual(
      [
        ...before.effective_authorities.filter((id) => id !== 'ADR-CHK-0012'),
        DOCUMENTATION_ADR,
      ].sort(),
    );
    expect(after.adrs.find((row) => row.adr_id === 'ADR-AUT-0009')).toMatchObject({
      effective: true,
    });
  });
});
