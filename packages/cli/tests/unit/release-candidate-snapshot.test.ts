import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isVerifiedReleaseCandidateSnapshot,
  verifyReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';

type ObjectFormat = 'sha1' | 'sha256';

function objectId(type: ReleaseGitObject['type'], bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format).update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function treeEntry(mode: string, name: string, id: string): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(id, 'hex')]);
}

function fixture(format: ObjectFormat = 'sha1') {
  const packageJson = Buffer.from('{"name":"@fixture/package"}\n');
  const executable = Buffer.from('#!/usr/bin/env node\n');
  const linked = Buffer.from('package.json');
  const config = Buffer.from('{"enabled":true}\n');
  const packageId = objectId('blob', packageJson, format);
  const executableId = objectId('blob', executable, format);
  const linkedId = objectId('blob', linked, format);
  const configId = objectId('blob', config, format);
  const nestedBytes = treeEntry('100644', 'config.json', configId);
  const nestedId = objectId('tree', nestedBytes, format);
  const gitlink = 'd'.repeat(format === 'sha1' ? 40 : 64);
  const treeBytes = Buffer.concat([
    treeEntry('100755', 'bin.js', executableId),
    treeEntry('120000', 'linked', linkedId),
    treeEntry('40000', 'nested', nestedId),
    treeEntry('100644', 'package.json', packageId),
    treeEntry('160000', 'submodule', gitlink),
  ]);
  const tree = objectId('tree', treeBytes, format);
  const commitBytes = Buffer.from(
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = objectId('commit', commitBytes, format);
  const objects = new Map<string, ReleaseGitObject>([
    [commit, { type: 'commit', bytes: commitBytes }],
    [tree, { type: 'tree', bytes: treeBytes }],
    [nestedId, { type: 'tree', bytes: nestedBytes }],
    [packageId, { type: 'blob', bytes: packageJson }],
    [executableId, { type: 'blob', bytes: executable }],
    [linkedId, { type: 'blob', bytes: linked }],
    [configId, { type: 'blob', bytes: config }],
  ]);
  return {
    repository: { id: 'fixture/repository', commit, tree },
    objects,
    ids: { packageId, executableId, linkedId, configId, nestedId },
    bytes: { packageJson, executable, linked, config, commitBytes, treeBytes, nestedBytes },
  };
}

function verify(
  value: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof verifyReleaseCandidateSnapshot>[0]> = {},
) {
  return verifyReleaseCandidateSnapshot({
    repository: value.repository,
    objects: value.objects,
    maximum_bytes: 1024 * 1024,
    maximum_entries: 100,
    ...overrides,
  });
}

function expectRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-policy-resolution-mismatch$/u);
}

describe('release candidate Git snapshot', () => {
  it.each(['sha1', 'sha256'] as const)(
    'rehashes raw %s commit/tree objects and exposes the complete path census',
    (format) => {
      const value = fixture(format);
      const snapshot = verify(value);

      expect(snapshot.repository).toEqual(value.repository);
      expect(snapshot.paths).toEqual([
        'bin.js',
        'linked',
        'nested/config.json',
        'package.json',
        'submodule',
      ]);
      expect(snapshot.read('package.json')).toEqual(value.bytes.packageJson);
      expect(snapshot.read('bin.js')).toEqual(value.bytes.executable);
      expect(snapshot.read('nested/config.json')).toEqual(value.bytes.config);
    },
  );

  it('does not permit symlink or gitlink contents to be read as candidate files', () => {
    const snapshot = verify(fixture());

    expectRefusal(() => snapshot.read('linked'));
    expectRefusal(() => snapshot.read('submodule'));
  });

  it('requires every reachable tree but defers an absent blob refusal until that file is read', () => {
    const missingTree = fixture();
    missingTree.objects.delete(missingTree.ids.nestedId);
    expectRefusal(() => verify(missingTree));

    const missingBlob = fixture();
    missingBlob.objects.delete(missingBlob.ids.packageId);
    const snapshot = verify(missingBlob);
    expect(snapshot.paths).toContain('package.json');
    expectRefusal(() => snapshot.read('package.json'));
  });

  it('refuses candidate/tree disagreement and object checksum drift', () => {
    const wrongTree = fixture();
    expectRefusal(() =>
      verify(wrongTree, { repository: { ...wrongTree.repository, tree: '0'.repeat(40) } }),
    );

    const wrongCandidate = fixture();
    expectRefusal(() =>
      verify(wrongCandidate, {
        repository: { ...wrongCandidate.repository, commit: '0'.repeat(40) },
      }),
    );

    const drifted = fixture();
    drifted.objects.set(drifted.ids.configId, { type: 'blob', bytes: Buffer.from('drift') });
    expectRefusal(() => verify(drifted));
  });

  it('copies object input and read buffers and brands only its own verified result', () => {
    const value = fixture();
    const snapshot = verify(value);
    value.bytes.packageJson.fill(0);

    const first = snapshot.read('package.json');
    first.fill(0);
    expect(snapshot.read('package.json')).toEqual(Buffer.from('{"name":"@fixture/package"}\n'));
    expect(isVerifiedReleaseCandidateSnapshot(snapshot)).toBe(true);
    expect(isVerifiedReleaseCandidateSnapshot({ ...snapshot })).toBe(false);
    expect(
      isVerifiedReleaseCandidateSnapshot({
        repository: snapshot.repository,
        paths: snapshot.paths,
        read: snapshot.read,
      }),
    ).toBe(false);
  });

  it('refuses object and path census quota exhaustion', () => {
    const value = fixture();
    const total = [...value.objects.values()].reduce(
      (sum, object) => sum + object.bytes.byteLength,
      0,
    );
    expectRefusal(() => verify(value, { maximum_bytes: total - 1 }));
    expectRefusal(() => verify(value, { maximum_entries: value.objects.size - 1 }));
  });
});
