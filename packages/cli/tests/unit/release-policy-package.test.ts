import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { resolveCanonicalPolicyContent, validateCanonicalPolicyContent } from '@devai-nyx/skills';
import {
  resolveAdopterPolicyMaterialization,
  type AdopterPolicyMaterializationSources,
} from '../../src/services/adopter-policy.js';
import { createReleasePolicyPackageTools } from '../../src/services/release-policy-package.js';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
  type ReleasePackageSnapshot,
} from '../../src/services/release-package-snapshot.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMA_ROOT = join(ROOT, 'law/schemas');
const POLICY_ROOT = join(ROOT, 'law/policy');
const DEFAULTS = [
  'domains.json',
  'thresholds.json',
  'scorecard-na.json',
  'glob-guards.json',
] as const;
const FRAMEWORK_VERSION = '1.4.5';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function header(path: string, mode: number, size: number): Buffer {
  if (Buffer.byteLength(path, 'utf8') > 100) throw new Error(`fixture path too long: ${path}`);
  const value = Buffer.alloc(512);
  value.write(path, 0, 100, 'utf8');
  octal(value, 100, 8, mode);
  octal(value, 108, 8, 0);
  octal(value, 116, 8, 0);
  octal(value, 124, 12, size);
  octal(value, 136, 12, 0);
  value.fill(0x20, 148, 156);
  value[156] = 0x30;
  value.write('ustar\0', 257, 6, 'ascii');
  value.write('00', 263, 2, 'ascii');
  octal(
    value,
    148,
    8,
    value.reduce((sum, byte) => sum + byte, 0),
  );
  return value;
}

function archive(files: readonly ReleasePackageFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const bytes = Buffer.from(file.bytes);
    blocks.push(
      header(`package/${file.path}`, file.mode, bytes.byteLength),
      bytes,
      Buffer.alloc((512 - (bytes.byteLength % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function directories(files: readonly ReleasePackageFile[]): string[] {
  return [
    ...new Set(
      files.flatMap(({ path }) => {
        const parts = path.split('/');
        return Array.from({ length: parts.length - 1 }, (_, index) =>
          parts.slice(0, index + 1).join('/'),
        );
      }),
    ),
  ].sort();
}

function policyDocument() {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.adopter-policy',
    policy_version: '1.0.0',
    release_verification: {
      schemaVersion: '1.0.0',
      policy_id: 'fixture.release-profile',
      policy_version: '1.0.0',
      release_unit: '@fixture/package',
      version_source: 'package.json',
      default_support: 'current',
      capability_tasks: { lint: ['lint'] },
      risk_capabilities: {},
      mutation_roster: [],
    },
  } as const;
}

const project = { schemaVersion: '1.0.0', project_type: 'framework' } as const;

function packageFiles(
  options: {
    readonly omit?: string;
    readonly replace?: Readonly<Record<string, string>>;
  } = {},
): ReleasePackageFile[] {
  const files: ReleasePackageFile[] = [
    {
      path: 'package.json',
      mode: 0o644,
      bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}\n'),
    },
    ...readdirSync(SCHEMA_ROOT)
      .filter((name) => name.endsWith('.schema.json'))
      .sort()
      .map(
        (name) =>
          ({
            path: `dist/runtime/index/schemas/${name}`,
            mode: 0o644,
            bytes: readFileSync(join(SCHEMA_ROOT, name)),
          }) satisfies ReleasePackageFile,
      ),
    ...DEFAULTS.map(
      (name) =>
        ({
          path: `dist/law/policy/${name}`,
          mode: 0o644,
          bytes: Buffer.from(resolveCanonicalPolicyContent(name)),
        }) satisfies ReleasePackageFile,
    ),
  ];
  return files
    .filter((file) => file.path !== options.omit)
    .map((file) => {
      const replacement = options.replace?.[file.path];
      return replacement === undefined
        ? file
        : { ...file, bytes: Buffer.from(replacement, 'utf8') };
    });
}

function snapshot(options: Parameters<typeof packageFiles>[0] = {}): ReleasePackageSnapshot {
  const files = packageFiles(options);
  const compressed = archive(files);
  const manifest = files
    .map(({ path, mode, bytes }) => ({ path, mode, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return verifyReleasePackageSnapshot({
    expected: {
      name: '@aarusso-nyx/devai',
      version: FRAMEWORK_VERSION,
      archive_sha256: sha256(compressed),
      content_manifest_sha256: canonicalSha256(manifest),
    },
    archive: compressed,
    installed_files: files,
    installed_directories: directories(files),
    maximum_archive_bytes: compressed.byteLength,
    maximum_unpacked_bytes: 2 * 1024 * 1024,
  });
}

function expectedMaterialization() {
  return resolveAdopterPolicyMaterialization({
    policy: policyDocument(),
    currentProject: project,
    frameworkVersion: FRAMEWORK_VERSION,
  });
}

function expectPackageRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-package-identity-mismatch$/u);
}

describe('verified package policy tools', () => {
  it('uses only verified package schemas and defaults while preserving materializer parity', () => {
    const tools = createReleasePolicyPackageTools(snapshot());
    const input = {
      policy: policyDocument(),
      currentProject: project,
      frameworkVersion: FRAMEWORK_VERSION,
    };

    expect([...tools.materialize(input)]).toEqual([...expectedMaterialization()]);
    expect(tools.parse('adopter-policy.schema.json', input.policy)).toEqual(input.policy);
    expect(tools.readJson('dist/law/policy/domains.json')).toEqual(
      JSON.parse(resolveCanonicalPolicyContent('domains.json')),
    );
  });

  it('requires an implementation-branded snapshot rather than a structural lookalike', () => {
    const checked = snapshot();
    expectPackageRefusal(() => createReleasePolicyPackageTools({ ...checked }));
  });

  it('does not fall back to candidate/source schemas or defaults when package members are missing', () => {
    const missingSchema = createReleasePolicyPackageTools(
      snapshot({ omit: 'dist/runtime/index/schemas/adopter-policy.schema.json' }),
    );
    expect(() =>
      missingSchema.materialize({
        policy: policyDocument(),
        currentProject: project,
        frameworkVersion: FRAMEWORK_VERSION,
      }),
    ).toThrow(/^rpl-adopter-binding-mismatch$/u);

    const missingDefault = createReleasePolicyPackageTools(
      snapshot({ omit: 'dist/law/policy/domains.json' }),
    );
    expect(() =>
      missingDefault.materialize({
        policy: policyDocument(),
        currentProject: project,
        frameworkVersion: FRAMEWORK_VERSION,
      }),
    ).toThrow(/^rpl-adopter-binding-mismatch$/u);
  });

  it('refuses a forged schema and uses snapshot defaults rather than same-name local defaults', () => {
    expectPackageRefusal(() =>
      createReleasePolicyPackageTools(
        snapshot({
          replace: { 'dist/runtime/index/schemas/adopter-policy.schema.json': '{not json' },
        }),
      ),
    );

    const alteredDomains = JSON.stringify({
      ...JSON.parse(resolveCanonicalPolicyContent('domains.json')),
      client: ['SNAPSHOT_ONLY'],
    });
    const tools = createReleasePolicyPackageTools(
      snapshot({ replace: { 'dist/law/policy/domains.json': alteredDomains } }),
    );
    const domains = JSON.parse(
      tools
        .materialize({
          policy: policyDocument(),
          currentProject: project,
          frameworkVersion: FRAMEWORK_VERSION,
        })
        .get('.devai/config/domains.json') ?? 'null',
    );
    expect(domains.client).toEqual(['SNAPSHOT_ONLY']);
  });

  it('requires synchronous true validators in both injection seams', () => {
    const asynchronousValidator = (() => Promise.resolve(true)) as unknown as ReturnType<
      AdopterPolicyMaterializationSources['getValidator']
    >;
    const sources: AdopterPolicyMaterializationSources = {
      getValidator: () => asynchronousValidator,
      readPolicy: (file) => readFileSync(join(POLICY_ROOT, file), 'utf8'),
    };
    expect(() =>
      resolveAdopterPolicyMaterialization(
        { policy: policyDocument(), currentProject: project, frameworkVersion: FRAMEWORK_VERSION },
        sources,
      ),
    ).toThrow(/^ADOPTER_POLICY_INVALID:/u);
    expect(() =>
      validateCanonicalPolicyContent(
        'glob-guards.json',
        readFileSync(join(POLICY_ROOT, 'glob-guards.json'), 'utf8'),
        () => asynchronousValidator,
      ),
    ).toThrow(/^canonical policy glob-guards\.json failed schema validation:/u);
  });
});
