import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const script = join(root, 'scripts/process/rehearsal.mjs');
const rehearsal = await import(pathToFileURL(script).href);
const prerequisites = await import(
  pathToFileURL(join(root, 'scripts/process/release-prerequisites.mjs')).href
);
const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'devai-process-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function assets() {
  const directory = temporary();
  const artifacts = {
    package: { file: 'devai.tgz', sha256: rehearsal.sha256('package') },
    sbom: { file: 'sbom.json', sha256: rehearsal.sha256('sbom') },
    site: { file: 'site.tar.gz', sha256: rehearsal.sha256('site') },
  };
  const manifest = {
    schemaVersion: '1.0.0',
    release: {
      repository: 'aarusso-nyx/devai',
      package: '@aarusso-nyx/devai',
      version: '1.4.5',
      tag: 'v1.4.5',
    },
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    ledger: { policy_digest: 'c'.repeat(64) },
    artifacts,
  };
  writeFileSync(join(directory, 'devai.tgz'), 'package');
  writeFileSync(join(directory, 'sbom.json'), 'sbom');
  writeFileSync(join(directory, 'site.tar.gz'), 'site');
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(manifest));
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    ['devai.tgz', 'sbom.json', 'site.tar.gz', 'release-manifest.json']
      .map((name) => `${rehearsal.sha256(readFileSync(join(directory, name)))}  ${name}\n`)
      .join(''),
  );
  const context = {
    repository: 'aarusso-nyx/devai',
    runId: '123',
    attempt: '1',
    artifactId: '456',
    artifactDigest: 'e'.repeat(64),
    workflowCommit: 'd'.repeat(40),
    controlCommit: 'f'.repeat(40),
  };
  const record = rehearsal.makeCompletion(directory, context);
  const run = {
    id: 123,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    repository: { full_name: context.repository },
    path: '.github/workflows/release.yml',
    head_sha: context.workflowCommit,
  };
  const artifact = {
    id: 456,
    name: 'devai-release-assets-1',
    expired: false,
    digest: `sha256:${context.artifactDigest}`,
    workflow_run: { id: 123 },
  };
  const expected = {
    ...context,
    tag: manifest.release.tag,
    commit: manifest.source.commit,
    tree: manifest.source.tree,
    ledger: manifest.ledger,
  };
  return { directory, record, run, artifact, expected };
}

describe('rehearsal promotion', () => {
  it('promotes unchanged bytes without any build or packaging dependency', () => {
    const fixture = assets();
    expect(
      rehearsal.validatePromotion(
        fixture.record,
        fixture.run,
        fixture.artifact,
        fixture.expected,
        rehearsal.inspectAssets(fixture.directory),
      ),
    ).toBe(true);
  });
  it.each([
    'runId',
    'attempt',
    'tag',
    'commit',
    'tree',
    'workflowCommit',
    'controlCommit',
    'repository',
  ] as const)('rejects a mismatched %s', (key) => {
    const f = assets();
    expect(() =>
      rehearsal.validatePromotion(
        f.record,
        f.run,
        f.artifact,
        { ...f.expected, [key]: 'wrong' },
        rehearsal.inspectAssets(f.directory),
      ),
    ).toThrow();
  });
  it.each(['failure', 'cancelled', 'skipped', 'timed_out'])(
    'rejects rehearsal conclusion %s',
    (conclusion) => {
      const f = assets();
      expect(() =>
        rehearsal.validatePromotion(
          f.record,
          { ...f.run, conclusion },
          f.artifact,
          f.expected,
          rehearsal.inspectAssets(f.directory),
        ),
      ).toThrow('PROMOTION_RUN_NOT_SUCCESSFUL');
    },
  );
  it.each(['id', 'name', 'digest', 'expired'])('rejects changed artifact %s', (key) => {
    const f = assets();
    expect(() =>
      rehearsal.validatePromotion(
        f.record,
        f.run,
        { ...f.artifact, [key]: 'wrong' },
        f.expected,
        rehearsal.inspectAssets(f.directory),
      ),
    ).toThrow('PROMOTION_ARTIFACT_IDENTITY_MISMATCH');
  });
  it('requires new rehearsal after changed verification inputs', () => {
    const f = assets();
    expect(() =>
      rehearsal.validatePromotion(
        f.record,
        f.run,
        f.artifact,
        { ...f.expected, ledger: { policy_digest: 'f'.repeat(64) } },
        rehearsal.inspectAssets(f.directory),
      ),
    ).toThrow('PROMOTION_TRUST_OR_EVIDENCE_CHANGED');
  });
  it('rejects changed bytes and extra release files', () => {
    const f = assets();
    writeFileSync(join(f.directory, 'devai.tgz'), 'changed');
    expect(() => rehearsal.inspectAssets(f.directory)).toThrow('REHEARSAL_ARTIFACT_MISMATCH');
    const next = assets();
    writeFileSync(join(next.directory, 'extra'), 'extra');
    expect(() => rehearsal.inspectAssets(next.directory)).toThrow('REHEARSAL_POPULATION_INVALID');
  });
});

describe('early prerequisites and evidence transport', () => {
  it('aggregates independent failures without requiring nonexistent RC receipts', () => {
    const repo = temporary();
    execFileSync('git', ['init', '--quiet', repo]);
    const config = { repo, packageRoot: '/missing-package', outputDir: '/missing-parent/export' };
    const result = prerequisites.inspectPrerequisites(config, '/missing-config');
    expect(result.ok).toBe(false);
    expect(result.checks.map((check: { id: string }) => check.id)).toEqual([
      'candidate',
      'control-location',
      'package',
      'maps',
      'signer',
      'destination',
      'policy',
    ]);
    expect(JSON.stringify(result)).not.toContain('receipt missing');
  });
  it('rejects failed or stale prerequisite bindings', () => {
    const previous = {
      schemaVersion: '1.0.0',
      phase: 'prerequisites',
      ok: true,
      bindings: { commit: 'a', policy: 'b' },
    };
    expect(() =>
      prerequisites.assertFresh(previous, {
        ...previous,
        bindings: { ...previous.bindings, policy: 'c' },
      }),
    ).toThrow('PREREQUISITES_STALE_OR_FAILED');
    expect(() => prerequisites.assertFresh(previous, { ...previous, ok: false })).toThrow();
  });
  it('exercises archive safety, integrity, private transport and no fallback', () => {
    const result = spawnSync('python3', ['-m', 'unittest', '-v', 'test_evidence_transport.py'], {
      cwd: join(root, 'scripts/process'),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('promotion command with remote fixtures', () => {
  it('downloads the explicit attempt and publishes no new build output', () => {
    const f = assets();
    const remote = temporary();
    const bin = join(remote, 'bin');
    mkdirSync(bin);
    const zip = (source: string, output: string) =>
      execFileSync('python3', [
        '-c',
        "import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(p,p.name) for p in sorted(root.iterdir())]; z.close()",
        source,
        output,
      ]);
    zip(f.directory, join(remote, 'assets.zip'));
    const artifactDigest = rehearsal.sha256(readFileSync(join(remote, 'assets.zip')));
    f.record.artifactDigest = artifactDigest;
    f.artifact.digest = `sha256:${artifactDigest}`;
    const completion = join(remote, 'completion');
    mkdirSync(completion);
    writeFileSync(join(completion, 'rehearsal-completion.json'), JSON.stringify(f.record));
    zip(completion, join(remote, 'completion.zip'));
    const completionArtifact = {
      id: 789,
      name: 'devai-rehearsal-1',
      expired: false,
      digest: `sha256:${rehearsal.sha256(readFileSync(join(remote, 'completion.zip')))}`,
    };
    writeFileSync(join(remote, 'run.json'), JSON.stringify(f.run));
    writeFileSync(
      join(remote, 'artifacts.json'),
      JSON.stringify([{ artifacts: [f.artifact, completionArtifact] }]),
    );
    writeFileSync(join(remote, 'expected.json'), JSON.stringify(f.expected));
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2).join(' ');
const file=args.includes('/attempts/')?'run.json':args.includes('/456/zip')?'assets.zip':args.includes('/789/zip')?'completion.zip':args.includes('/artifacts?')?'artifacts.json':null;
if(!file)process.exit(99);
process.stdout.write(fs.readFileSync(process.env.FAKE_REMOTE+'/'+file));
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    for (const command of ['npm', 'pnpm', 'tsc', 'tar']) {
      writeFileSync(
        join(bin, command),
        '#!/bin/sh\nprintf invoked >> "$FAKE_REMOTE/build-invoked"\nexit 88\n',
      );
      chmodSync(join(bin, command), 0o755);
    }
    const result = spawnSync(
      process.execPath,
      [script, 'promote', join(remote, 'promoted'), join(remote, 'expected.json')],
      {
        encoding: 'utf8',
        env: { ...process.env, FAKE_REMOTE: remote, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).buildInvocations).toBe(0);
    expect(existsSync(join(remote, 'build-invoked'))).toBe(false);
    expect(readFileSync(join(remote, 'promoted/devai.tgz'))).toEqual(
      readFileSync(join(f.directory, 'devai.tgz')),
    );
  });
});

describe('publication recovery observations', () => {
  it.each([
    { kind: 'release', payload: [[{ tag_name: 'v1.4.5', draft: false }]], expected: 'present' },
    { kind: 'release', payload: [[{ tag_name: 'v1.4.5', draft: true }]], expected: 'draft' },
    { kind: 'release', payload: [[]], expected: 'absent' },
    { kind: 'registry', payload: ['1.4.4', '1.4.5'], expected: 'present' },
    { kind: 'registry', payload: ['1.4.4'], expected: 'absent' },
  ])('distinguishes $kind $expected after a successful read', ({ kind, payload, expected }) => {
    const directory = temporary();
    writeFileSync(join(directory, 'payload.json'), JSON.stringify(payload));
    for (const name of ['gh', 'npm']) {
      writeFileSync(
        join(directory, name),
        '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.STATE_FIXTURE));\n',
      );
      chmodSync(join(directory, name), 0o755);
    }
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/process/publication-state.mjs'),
        kind,
        kind === 'release' ? 'v1.4.5' : '1.4.5',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          STATE_FIXTURE: join(directory, 'payload.json'),
          PATH: `${directory}:${process.env.PATH}`,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });
  it('never converts an authentication or network error into absence', () => {
    const directory = temporary();
    for (const name of ['gh', 'npm']) {
      writeFileSync(join(directory, name), '#!/bin/sh\nexit 1\n');
      chmodSync(join(directory, name), 0o755);
    }
    for (const kind of ['release', 'registry']) {
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/process/publication-state.mjs'), kind, '1.4.5'],
        { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('PUBLICATION_STATE_UNKNOWN');
    }
  });
});
