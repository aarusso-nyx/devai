import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const { missingReleaseAssets } = await import(
  pathToFileURL(resolve('scripts/process/release-recovery.mjs')).href
);
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-recovery-'));
  roots.push(root);
  const expected = join(root, 'expected');
  const observed = join(root, 'observed');
  mkdirSync(expected);
  mkdirSync(observed);
  writeFileSync(join(expected, 'package.tgz'), 'sealed package');
  writeFileSync(join(expected, 'site.tar.gz'), 'sealed site');
  return { expected, observed };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('draft release recovery', () => {
  it.each(['draft', 'present'])('matching %s needs no uploads', (state) => {
    const f = fixture();
    writeFileSync(join(f.observed, 'package.tgz'), 'sealed package');
    writeFileSync(join(f.observed, 'site.tar.gz'), 'sealed site');
    expect(missingReleaseAssets(f.expected, f.observed, state)).toEqual([]);
  });
  it('resumes only missing draft members', () => {
    const f = fixture();
    writeFileSync(join(f.observed, 'package.tgz'), 'sealed package');
    expect(missingReleaseAssets(f.expected, f.observed, 'draft')).toEqual(['site.tar.gz']);
  });
  it('can populate a confirmed empty draft', () => {
    const f = fixture();
    expect(missingReleaseAssets(f.expected, f.observed, 'draft')).toEqual([
      'package.tgz',
      'site.tar.gz',
    ]);
  });
  it.each(['package.tgz', 'extra.tgz'])(
    'refuses differing or extra member %s before returning missing uploads',
    (name) => {
      const f = fixture();
      writeFileSync(join(f.observed, name), 'untrusted bytes');
      expect(() => missingReleaseAssets(f.expected, f.observed, 'draft')).toThrow(
        'RELEASE_RECOVERY_ASSET_MISMATCH',
      );
    },
  );
  it('never repairs an incomplete published release', () => {
    const f = fixture();
    expect(() => missingReleaseAssets(f.expected, f.observed, 'present')).toThrow(
      'RELEASE_RECOVERY_PUBLISHED_INCOMPLETE',
    );
  });
  it('refuses unknown state', () => {
    const f = fixture();
    expect(() => missingReleaseAssets(f.expected, f.observed, 'unknown')).toThrow(
      'RELEASE_RECOVERY_STATE_UNKNOWN',
    );
  });
  it('refuses a downloaded symbolic link', () => {
    const f = fixture();
    symlinkSync(join(f.expected, 'package.tgz'), join(f.observed, 'package.tgz'));
    expect(() => missingReleaseAssets(f.expected, f.observed, 'draft')).toThrow(
      'RELEASE_RECOVERY_UNSAFE_ASSET',
    );
  });
});

describe('release workflow effect ordering', () => {
  it.each(['missing', 'mismatch', 'matching'])(
    'reconciles %s without replacing existing bytes',
    (scenario) => {
      const f = fixture();
      const directory = resolve(f.expected, '..');
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      mkdirSync(join(directory, 'tmp'));
      symlinkSync(resolve('.'), join(directory, 'release-control'));
      symlinkSync(f.expected, join(directory, 'release-assets'));
      writeFileSync(
        join(f.observed, 'package.tgz'),
        scenario === 'mismatch' ? 'wrong' : 'sealed package',
      );
      if (scenario === 'matching') writeFileSync(join(f.observed, 'site.tar.gz'), 'sealed site');
      const mock = join(bin, 'gh');
      writeFileSync(
        mock,
        `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2),remote=process.env.REMOTE,dir=process.env.RECOVERY_FIXTURE;
if(a[0]==='api')process.stdout.write(JSON.stringify([[{tag_name:'v1.5.0',draft:process.env.SCENARIO!=='matching'}]]));
else if(a[1]==='view')process.stdout.write(a.includes('isPrerelease')?'false':String(fs.readdirSync(remote).length));
else if(a[1]==='download'){const dest=a[a.indexOf('--dir')+1];for(const name of fs.readdirSync(remote))fs.copyFileSync(path.join(remote,name),path.join(dest,name));}
else if(a[1]==='upload'){fs.appendFileSync(path.join(dir,'writes'),'upload\\n');fs.copyFileSync(a[3],path.join(remote,path.basename(a[3])),fs.constants.COPYFILE_EXCL);}
else if(a[1]==='edit')fs.appendFileSync(path.join(dir,'writes'),'publish\\n');
else process.exit(8);
`,
      );
      chmodSync(mock, 0o755);
      const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
      const start = workflow.indexOf('          assets=()');
      const end = workflow.indexOf('          else\n            release_flags=', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const body = workflow
        .slice(start, end)
        .split('\n')
        .map((line) => line.slice(10))
        .join('\n');
      const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${body}\nfi`], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REMOTE: f.observed,
          RECOVERY_FIXTURE: directory,
          SCENARIO: scenario,
          RELEASE_TAG: 'v1.5.0',
          RELEASE_IS_PRERELEASE: 'false',
          GITHUB_REPOSITORY: 'aarusso-nyx/devai',
          RUNNER_TEMP: join(directory, 'tmp'),
        },
      });
      if (scenario === 'mismatch') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('RELEASE_RECOVERY_ASSET_MISMATCH');
        expect(existsSync(join(directory, 'writes'))).toBe(false);
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        if (scenario === 'missing')
          expect(readFileSync(join(directory, 'writes'), 'utf8')).toBe('upload\npublish\n');
        else expect(existsSync(join(directory, 'writes'))).toBe(false);
      }
    },
  );
});
