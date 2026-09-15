import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildCanonicalDescriptorHandoffReport } from '../../src/commands/check/documentation-report.js';
import { checkDocsGovernance } from '../../src/commands/check/docs-governance.js';
import { invokeDevaiCli } from '../../src/cli-runtime.js';

const SOURCE_ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-cli-shard06-documentation-runtime-'));
  roots.push(root);
});

afterEach(() => {
  for (const fixtureRoot of roots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(relativePath: string, value: unknown): void {
  write(relativePath, `${JSON.stringify(value)}\n`);
}

function config(
  builder: 'docusaurus' | 'jekyll' = 'docusaurus',
  kind: 'library' | 'application' = 'application',
  buildCommand?: string,
): void {
  writeJson('.devai/config/project.json', {
    repo: { kind },
    docs: { builder, ...(buildCommand === undefined ? {} : { build_command: buildCommand }) },
  });
}

function governance() {
  return checkDocsGovernance({ repoRoot: root, noPublishCheck: true });
}

function governanceFinding(ruleId: string) {
  return governance().findings.find((finding) => finding.ruleId === ruleId);
}

function lawFixture(): void {
  cpSync(join(SOURCE_ROOT, 'law'), join(root, 'law'), { recursive: true, dereference: true });
}

function resetLawFixture(): void {
  rmSync(join(root, 'law'), { recursive: true, force: true });
  lawFixture();
}

function architecture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, 'law/policy/documentation-information-architecture.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function descriptorReport() {
  return buildCanonicalDescriptorHandoffReport(root);
}

describe('S06-B source-derived documentation reports', () => {
  it('projects every canonical descriptor category in exact source order', () => {
    lawFixture();
    const report = descriptorReport();
    const expectedCategories = [
      'check-suites',
      'sense-presets',
      'inventory-slices',
      'adoption-tiers',
      'executor-kinds',
      'agent-selection-modes',
      'roles',
      'effects',
      'verdicts',
      'action-lifecycles',
      'surface-tiers',
      'sensor-kinds',
      'runtimes',
      'supported-efforts',
    ];
    expect(report).toMatchObject({ scope: 'current-canonical-descriptors' });
    expect(Object.keys(report.categories)).toEqual(expectedCategories);

    const suites = JSON.parse(readFileSync(join(root, 'law/policy/check-suites.json'), 'utf8')) as {
      suites: Array<{ name: string }>;
    };
    const presets = JSON.parse(
      readFileSync(join(root, 'law/policy/sense-presets.json'), 'utf8'),
    ) as {
      presets: Array<{ name: string }>;
    };
    const round = JSON.parse(
      readFileSync(join(root, 'law/policy/round-execution.json'), 'utf8'),
    ) as {
      vocabularies: Record<string, unknown>;
    };
    const task = JSON.parse(readFileSync(join(root, 'law/schemas/task.schema.json'), 'utf8')) as {
      properties: { executor: { oneOf: Array<{ properties: { kind: { const: string } } }> } };
      $defs: { agentSelection: { properties: { mode: { const: string } } } };
    };
    const registry = JSON.parse(
      readFileSync(join(root, 'law/schemas/action-registry.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    const registryDefs = registry['$defs'] as Record<string, unknown>;
    const authority = registryDefs['authorityContract'] as Record<string, unknown>;
    const authorityProperties = authority['properties'] as Record<string, unknown>;
    const subject = authorityProperties['subject'] as Record<string, unknown>;
    const subjectBranches = subject['oneOf'] as Array<Record<string, unknown>>;
    const human = subjectBranches[1] as Record<string, unknown>;
    const humanProperties = human['properties'] as Record<string, unknown>;
    const allowedRoles = humanProperties['allowed_roles'] as Record<string, unknown>;
    const roleItems = allowedRoles['items'] as Record<string, unknown>;
    const entries = registry['properties'] as Record<string, unknown>;
    const entriesSchema = entries['entries'] as Record<string, unknown>;
    const entryItems = entriesSchema['items'] as Record<string, unknown>;
    const entryProperties = entryItems['properties'] as Record<string, unknown>;
    const effect = entryProperties['effect'] as Record<string, unknown>;
    const sensor = JSON.parse(
      readFileSync(join(root, 'law/policy/sensor-registry.json'), 'utf8'),
    ) as {
      entries: Array<{ kind: string }>;
    };
    const runtimes = JSON.parse(
      readFileSync(join(root, 'law/policy/model-runtime-registry.json'), 'utf8'),
    ) as { runtimes: Array<{ id: string; efforts: string[] }> };
    const expected: Record<string, string[]> = {
      'check-suites': suites.suites.map((entry) => entry.name),
      'sense-presets': presets.presets.map((entry) => entry.name),
      'inventory-slices': (round.vocabularies.inventory_slices as Array<{ name: string }>).map(
        (entry) => entry.name,
      ),
      'adoption-tiers': (round.vocabularies.adoption_tiers as Array<{ name: string }>).map(
        (entry) => entry.name,
      ),
      'executor-kinds': task.properties.executor.oneOf.map((entry) => entry.properties.kind.const),
      'agent-selection-modes': [task.$defs.agentSelection.properties.mode.const],
      roles: roleItems['enum'] as string[],
      effects: effect['enum'] as string[],
      verdicts: round.vocabularies.verdicts as string[],
      'action-lifecycles': round.vocabularies.action_lifecycles as string[],
      'surface-tiers': (round.vocabularies.surface_tiers as Array<{ name: string }>).map(
        (entry) => entry.name,
      ),
      'sensor-kinds': sensor.entries.map((entry) => entry.kind),
      runtimes: [...new Set(runtimes.runtimes.map((entry) => entry.id))].sort((a, b) =>
        Buffer.from(a).compare(Buffer.from(b)),
      ),
      'supported-efforts': [...new Set(runtimes.runtimes.flatMap((entry) => entry.efforts))].sort(
        (a, b) => Buffer.from(a).compare(Buffer.from(b)),
      ),
    };

    for (const id of expectedCategories) {
      expect(report.categories[id]?.canonical_source).toBe(
        (architecture().categories as Array<Record<string, string>>).find(
          (category) => category.category_id === id,
        )?.canonical_source,
      );
      expect(report.categories[id]?.expected_ids).toEqual(expected[id]);
      expect(report.categories[id]?.documented_ids).toEqual(expected[id]);
      expect(report.categories[id]?.missing).toEqual([]);
      expect(report.categories[id]?.extra).toEqual([]);
      expect(report.categories[id]?.duplicates).toEqual([]);
    }
  });

  it.each([
    [
      'check-suites',
      'law/policy/check-suites.json',
      'suites',
      'CHECK_DESCRIPTOR_CHECK_SUITES_INVALID',
    ],
    [
      'sense-presets',
      'law/policy/sense-presets.json',
      'presets',
      'CHECK_DESCRIPTOR_SENSE_PRESETS_INVALID',
    ],
    [
      'inventory-slices',
      'law/policy/round-execution.json',
      'vocabularies.inventory_slices',
      'CHECK_DESCRIPTOR_INVENTORY_SLICES_INVALID',
    ],
    [
      'adoption-tiers',
      'law/policy/round-execution.json',
      'vocabularies.adoption_tiers',
      'CHECK_DESCRIPTOR_ADOPTION_TIERS_INVALID',
    ],
  ] as const)('rejects malformed record populations for %s', (_id, path, field, errorCode) => {
    lawFixture();
    const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
    const parts = field.split('.');
    let target: Record<string, unknown> = value;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1) as string] = [null];
    writeJson(path, value);
    expect(() => descriptorReport()).toThrow(`${errorCode}: expected object array`);
  });

  it('rejects malformed schema arrays, discriminator constants, and registry enums', () => {
    lawFixture();
    const taskPath = 'law/schemas/task.schema.json';
    const task = JSON.parse(readFileSync(join(root, taskPath), 'utf8')) as Record<string, unknown>;
    const taskProperties = task['properties'] as Record<string, unknown>;
    const executor = taskProperties['executor'] as Record<string, unknown>;
    executor['oneOf'] = [null];
    writeJson(taskPath, task);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_EXECUTORS_INVALID: expected object array',
    );

    lawFixture();
    const taskWithBadKind = JSON.parse(readFileSync(join(root, taskPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const badTaskProperties = taskWithBadKind['properties'] as Record<string, unknown>;
    const badExecutor = badTaskProperties['executor'] as Record<string, unknown>;
    badExecutor['oneOf'] = [{ properties: { kind: {} } }];
    writeJson(taskPath, taskWithBadKind);
    expect(() => descriptorReport()).toThrow('CHECK_DESCRIPTOR_EXECUTORS_INVALID:0');

    lawFixture();
    const registryPath = 'law/schemas/action-registry.schema.json';
    const registry = JSON.parse(readFileSync(join(root, registryPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const badRegistryDefs = registry['$defs'] as Record<string, unknown>;
    const badAuthority = badRegistryDefs['authorityContract'] as Record<string, unknown>;
    const badAuthorityProperties = badAuthority['properties'] as Record<string, unknown>;
    const badSubject = badAuthorityProperties['subject'] as Record<string, unknown>;
    const badBranches = badSubject['oneOf'] as Array<Record<string, unknown>>;
    const badHuman = badBranches[1] as Record<string, unknown>;
    const badHumanProperties = badHuman['properties'] as Record<string, unknown>;
    const badAllowedRoles = badHumanProperties['allowed_roles'] as Record<string, unknown>;
    const badRoleItems = badAllowedRoles['items'] as Record<string, unknown>;
    badRoleItems['enum'] = ['architect', 7];
    writeJson(registryPath, registry);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_ROLES_INVALID: expected string array',
    );

    lawFixture();
    const taskSelection = JSON.parse(readFileSync(join(root, taskPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const selectionDefs = taskSelection['$defs'] as Record<string, unknown>;
    const agentSelection = selectionDefs['agentSelection'] as Record<string, unknown>;
    const selectionProperties = agentSelection['properties'] as Record<string, unknown>;
    const mode = selectionProperties['mode'] as Record<string, unknown>;
    mode['const'] = 4;
    writeJson(taskPath, taskSelection);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_SELECTION_MODES_INVALID: expected exact const',
    );
  });

  it('rejects malformed descriptor vocabularies and registry entries with exact error identities', () => {
    resetLawFixture();
    const roundPath = 'law/policy/round-execution.json';
    const round = JSON.parse(readFileSync(join(root, roundPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const vocabularies = round['vocabularies'] as Record<string, unknown>;
    vocabularies['verdicts'] = [7];
    writeJson(roundPath, round);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_VERDICTS_INVALID: expected string array',
    );

    resetLawFixture();
    const lifecycleRound = JSON.parse(readFileSync(join(root, roundPath), 'utf8')) as Record<
      string,
      unknown
    >;
    (lifecycleRound['vocabularies'] as Record<string, unknown>)['action_lifecycles'] = [7];
    writeJson(roundPath, lifecycleRound);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_LIFECYCLES_INVALID: expected string array',
    );

    resetLawFixture();
    const registryPath = 'law/schemas/action-registry.schema.json';
    const registry = JSON.parse(readFileSync(join(root, registryPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const registryProperties = (registry['properties'] as Record<string, unknown>)[
      'entries'
    ] as Record<string, unknown>;
    const entryProperties = registryProperties['items'] as Record<string, unknown>;
    const effect = (entryProperties['properties'] as Record<string, unknown>)['effect'] as Record<
      string,
      unknown
    >;
    effect['enum'] = [7];
    writeJson(registryPath, registry);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_EFFECTS_INVALID: expected string array',
    );

    resetLawFixture();
    const sensorPath = 'law/policy/sensor-registry.json';
    const sensor = JSON.parse(readFileSync(join(root, sensorPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const sensorEntries = sensor['entries'] as Array<Record<string, unknown>>;
    if (!sensorEntries[0]) throw new Error('sensor fixture missing');
    sensorEntries[0]['kind'] = 7;
    writeJson(sensorPath, sensor);
    expect(() => descriptorReport()).toThrow('CHECK_DESCRIPTOR_SENSOR_KINDS_INVALID:0');

    resetLawFixture();
    const runtimePath = 'law/policy/model-runtime-registry.json';
    const runtime = JSON.parse(readFileSync(join(root, runtimePath), 'utf8')) as Record<
      string,
      unknown
    >;
    const runtimes = runtime['runtimes'] as Array<Record<string, unknown>>;
    if (!runtimes[0]) throw new Error('runtime fixture missing');
    runtimes[0]['id'] = 7;
    writeJson(runtimePath, runtime);
    expect(() => descriptorReport()).toThrow('CHECK_DESCRIPTOR_RUNTIMES_INVALID:0');

    resetLawFixture();
    const effortsRuntime = JSON.parse(readFileSync(join(root, runtimePath), 'utf8')) as Record<
      string,
      unknown
    >;
    const effortRuntimes = effortsRuntime['runtimes'] as Array<Record<string, unknown>>;
    if (!effortRuntimes[0]) throw new Error('effort fixture missing');
    effortRuntimes[0]['efforts'] = [7];
    writeJson(runtimePath, effortsRuntime);
    expect(() => descriptorReport()).toThrow(
      'CHECK_DESCRIPTOR_EFFORTS_INVALID: expected string array',
    );
  });

  it('deduplicates and UTF-8 sorts runtimes and supported efforts', () => {
    lawFixture();
    writeJson('law/policy/model-runtime-registry.json', {
      runtimes: [
        { id: 'é', efforts: ['high', 'a'] },
        { id: 'z', efforts: ['a', 'low'] },
        { id: 'a', efforts: ['é', 'high'] },
        { id: 'a', efforts: [] },
      ],
    });
    const report = descriptorReport();
    expect(report.categories.runtimes?.expected_ids).toEqual(['a', 'z', 'é']);
    expect(report.categories['supported-efforts']?.expected_ids).toEqual(['a', 'high', 'low', 'é']);
  });

  it('rejects duplicate and unknown architecture category identities before traversal', () => {
    lawFixture();
    const architectureValue = architecture();
    architectureValue.categories = [
      { category_id: 'check-suites', canonical_source: 'law/policy/check-suites.json' },
      { category_id: 'check-suites', canonical_source: 'law/policy/check-suites.json' },
    ];
    writeJson('law/policy/documentation-information-architecture.json', architectureValue);
    expect(() => descriptorReport()).toThrow('CHECK_DESCRIPTOR_CATEGORY_INVALID');

    lawFixture();
    const unknown = architecture();
    unknown.categories = [
      { category_id: 'unknown', canonical_source: 'law/policy/check-suites.json' },
    ];
    writeJson('law/policy/documentation-information-architecture.json', unknown);
    expect(() => descriptorReport()).toThrow('CHECK_DESCRIPTOR_CATEGORY_UNKNOWN:unknown');
  });
});

describe('S06-B docs governance report', () => {
  it('returns the exact fail-closed aggregate when project configuration is absent', () => {
    const report = governance();
    expect(report).toMatchObject({
      verdict: 'fail',
      rules_checked: 14,
      fail_count: 2,
      warn_count: 0,
    });
    expect(report.findings.map((finding) => finding.ruleId)).toEqual([
      'docs-governance.classification',
      'docs-governance.builder-declared',
      'docs-governance.library-docusaurus-required',
      'docs-governance.opt-out-adr-required',
      'docs-governance.site-dir-shape',
      'docs-governance.build-toolchain',
      'docs-governance.gh-pages-branch',
      'docs-governance.no-ci-publish',
      'docs-governance.config-not-placeholder',
      'docs-ia.landing-exists',
      'docs-ia.constitution-published',
      'docs-ia.sidebar-curated',
      'docs-ia.framework-meta-split',
      'docs-ia.dashboard-current',
    ]);
  });

  it('requires the application Jekyll opt-out ADR sections and reports unreadable ADRs', () => {
    config('jekyll', 'application', '');
    expect(governanceFinding('docs-governance.opt-out-adr-required')).toMatchObject({
      severity: 'fail',
    });
    for (const missing of ['rationale', 'reviewer', 'date', 'sunset']) {
      write(
        'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md',
        ['rationale', 'reviewer', 'date', 'sunset']
          .filter((section) => section !== missing)
          .map((section) => `## ${section}`)
          .join('\n'),
      );
      expect(governanceFinding('docs-governance.opt-out-adr-required')?.message).toContain(missing);
    }
    rmSync(join(root, 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'));
    mkdirSync(join(root, 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'));
    expect(governanceFinding('docs-governance.opt-out-adr-required')).toMatchObject({
      severity: 'fail',
      message: 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md is unreadable',
    });
  });

  it('distinguishes each known CI docs publisher and ignores unrelated workflow files', () => {
    config('jekyll', 'application', '');
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', '# rationale reviewer date sunset\n');
    write('.github/workflows/ignored.txt', 'actions/deploy-pages\n');
    expect(governanceFinding('docs-governance.no-ci-publish')).toMatchObject({ severity: 'pass' });
    for (const [name, pattern] of [
      ['deploy.yaml', 'actions/deploy-pages'],
      ['pages.yml', 'JamesIves/github-pages-deploy-action'],
      ['gh-pages.yml', 'peaceiris/actions-gh-pages'],
    ] as const) {
      write(`.github/workflows/${name}`, `name: docs\nuses: ${pattern}\n`);
      expect(governanceFinding('docs-governance.no-ci-publish')).toMatchObject({
        severity: 'fail',
        locations: [`.github/workflows/${name}`],
      });
      rmSync(join(root, `.github/workflows/${name}`));
    }
  });

  it('reports build-toolchain pass, npx fallback, and warning outcomes exactly', async () => {
    await withAuthorityHostTestScope(() => {
      config('docusaurus', 'application', 'node --version');
      expect(governanceFinding('docs-governance.build-toolchain')).toMatchObject({
        severity: 'pass',
        message: 'Build toolchain "node" is on PATH and responds to --version',
      });

      config('docusaurus', 'application', 'npx docusaurus build');
      expect(governanceFinding('docs-governance.build-toolchain')).toMatchObject({
        severity: 'pass',
        message: 'Build toolchain "npx" is on PATH and responds to --version',
      });

      config('docusaurus', 'application', '');
      expect(governanceFinding('docs-governance.build-toolchain')).toMatchObject({
        severity: 'warn',
        message: 'build_command is empty or unresolvable',
      });
    });
  });

  it.each([
    'https://example.com',
    'https://example.invalid/',
    'https://example.test',
    'https://your-docusaurus-site.example.com',
    'http://localhost:3000/',
  ])('rejects placeholder Docusaurus URL %s', (url) => {
    config('docusaurus', 'application', '');
    write(
      'docs/site/docusaurus.config.ts',
      `export default {\n  url: '${url}',\n  organizationName: 'acme',\n};\n`,
    );
    expect(governanceFinding('docs-governance.config-not-placeholder')).toMatchObject({
      severity: 'fail',
      message: expect.stringContaining('contains placeholder value(s): url='),
      locations: ['docs/site/docusaurus.config.ts:2'],
    });
  });

  it.each(['facebook', 'organization-name', 'your-org', 'placeholder', 'devai-org'])(
    'rejects placeholder organization %s',
    (organizationName) => {
      config('docusaurus', 'application', '');
      write(
        'docs/site/docusaurus.config.js',
        `module.exports = {\n  url: 'https://docs.acme.test',\n  organizationName: '${organizationName}',\n};\n`,
      );
      expect(governanceFinding('docs-governance.config-not-placeholder')).toMatchObject({
        severity: 'fail',
        message: expect.stringContaining('organizationName='),
        locations: ['docs/site/docusaurus.config.js:3'],
      });
    },
  );

  it('accepts real config values, warns on unparseable config, and skips Jekyll', () => {
    config('docusaurus', 'application', '');
    write(
      'docs/site/docusaurus.config.ts',
      `export default {\n  url: 'https://docs.acme.test',\n  organizationName: 'acme',\n};\n`,
    );
    expect(governanceFinding('docs-governance.config-not-placeholder')).toMatchObject({
      severity: 'pass',
    });
    write('docs/site/docusaurus.config.ts', 'export default { title: "Docs" };\n');
    expect(governanceFinding('docs-governance.config-not-placeholder')).toMatchObject({
      severity: 'warn',
      message: expect.stringContaining('could not parse'),
    });

    config('jekyll', 'application', '');
    expect(governanceFinding('docs-governance.config-not-placeholder')).toMatchObject({
      severity: 'pass',
      message: 'Skipped — rule only applies to docs.builder = "docusaurus"',
    });
  });

  it('enforces the information-architecture landing and sibling split', () => {
    config('docusaurus', 'application', '');
    write('law/constitution.md', '# Constitution\n');
    expect(governanceFinding('docs-ia.landing-exists')).toMatchObject({ severity: 'fail' });
    write('docs/start/index.md', '# Start\n');
    expect(governanceFinding('docs-ia.landing-exists')).toMatchObject({
      severity: 'pass',
      message: 'Landing present (docs/start/index.md)',
    });
    rmSync(join(root, 'docs/start/index.md'));
    write('docs/site/src/pages/index.tsx', 'export default function Home() {}\n');
    expect(governanceFinding('docs-ia.landing-exists')?.message).toBe(
      'Landing present (docs/site/src/pages/index.tsx)',
    );

    expect(governanceFinding('docs-ia.framework-meta-split')).toMatchObject({
      severity: 'pass',
      message: 'law/ and docs/ are siblings',
    });
    rmSync(join(root, 'law'), { recursive: true, force: true });
    expect(governanceFinding('docs-ia.framework-meta-split')).toMatchObject({
      severity: 'fail',
      message: 'Law/Docs sibling split missing: law/',
    });
  });

  it('checks constitution destinations and versioned snapshots', () => {
    config('docusaurus', 'application', '');
    write('law/constitution.md', '# Constitution\n');
    expect(governanceFinding('docs-ia.constitution-published')).toMatchObject({
      severity: 'fail',
      message: 'Constitution exists at repo root but no Pages destination is set up.',
    });
    write('docs/reference/law.md', '# Synced\n');
    expect(governanceFinding('docs-ia.constitution-published')).toMatchObject({ severity: 'pass' });
    writeJson('docs/site/versions.json', ['1.4.5', '1.5.0']);
    expect(governanceFinding('docs-ia.constitution-published')).toMatchObject({
      severity: 'fail',
      message: 'versioned_docs missing constitution snapshot for: 1.4.5, 1.5.0',
    });
    write('docs/site/versioned_docs/version-1.4.5/framework/constitution.md', '# Old\n');
    write('docs/site/versioned_docs/version-1.5.0/framework/constitution.md', '# Current\n');
    expect(governanceFinding('docs-ia.constitution-published')).toMatchObject({ severity: 'pass' });
    write('docs/site/versions.json', 'not json\n');
    expect(governanceFinding('docs-ia.constitution-published')).toMatchObject({ severity: 'pass' });
  });

  it('requires curated sidebar labels and reports dashboard freshness', () => {
    config('docusaurus', 'application', '');
    expect(governanceFinding('docs-ia.sidebar-curated')).toMatchObject({ severity: 'pass' });
    write(
      'docs/site/sidebars.ts',
      "export default { docs: [{ type: 'autogenerated', dirName: '.' }] };\n",
    );
    expect(governanceFinding('docs-ia.sidebar-curated')).toMatchObject({
      severity: 'fail',
      message: expect.stringContaining('fully autogenerated'),
    });
    write(
      'docs/site/sidebars.ts',
      "export default { docs: [{ type: 'category', label: 'Start', items: [] }] };\n",
    );
    expect(governanceFinding('docs-ia.sidebar-curated')).toMatchObject({
      severity: 'pass',
      message: 'Sidebar carries explicit labels',
    });

    expect(governanceFinding('docs-ia.dashboard-current')).toMatchObject({
      severity: 'pass',
      message: 'Dashboards current (or absent)',
    });
    write(
      'docs/site/docs/reference/test-matrix.md',
      `---\nlast_built_at: ${new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()}\n---\n# Matrix\n`,
    );
    expect(governanceFinding('docs-ia.dashboard-current')).toMatchObject({
      severity: 'warn',
      message: expect.stringContaining('Dashboards older than 30 days:'),
    });
    write('docs/site/docs/reference/test-matrix.md', '---\nlast_built_at: sometime\n---\n');
    expect(governanceFinding('docs-ia.dashboard-current')).toMatchObject({ severity: 'pass' });
  });
});

describe('S06-B runtime invocation boundary', () => {
  it('rejects invalid argument containers and values before dispatch', async () => {
    await expect(invokeDevaiCli(null as unknown as readonly string[])).rejects.toThrow(
      'release-host-argv-invalid',
    );
    await expect(invokeDevaiCli(['--version', 7] as unknown as readonly string[])).rejects.toThrow(
      'release-host-argv-invalid',
    );
  });

  it('routes help and version through the captured public runtime boundary', async () => {
    const empty = await invokeDevaiCli([]);
    expect(empty.exit_code).toBe(0);
    expect(empty.stdout).toContain('Usage: devai');

    const help = await invokeDevaiCli(['check', '--help']);
    expect(help.exit_code).toBe(0);
    expect(help.stdout).toContain('check');

    const version = await invokeDevaiCli(['--version']);
    expect(version.exit_code).toBe(0);
  });
});
