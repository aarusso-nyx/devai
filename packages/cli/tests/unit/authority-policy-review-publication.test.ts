// P1 publication fixtures exercise the unchanged ADR-AUT-0005 primitive independently.
// They do not establish production broker admission or authorize any live binding.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishNoReplaceSteps } from '../../../authority/src/boundaries/host-publish.js';

const roots: string[] = [];
function directory() {
  const root = fs.mkdtempSync(join(tmpdir(), 'devai-p1-publish-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('REC-B1-A-P1 disposable exact publication primitive', () => {
  it('P1-16 publishes whole exact bytes with identity and one durable target', () => {
    const root = directory();
    const target = join(root, 'authority-policy.json');
    const bytes = Buffer.from('{"fixture":"one exact artifact"}\n');
    const identity = publishNoReplaceSteps(target, bytes);
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(sha(fs.readFileSync(target))).toBe(sha(bytes));
    const stat = fs.lstatSync(target, { bigint: true });
    expect(identity).toEqual({ dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs });
    expect(fs.readdirSync(root)).toEqual(['authority-policy.json']);
  });

  it('P1-18 lets at most one independent real process create and preserves winner bytes', async () => {
    const root = directory();
    const target = join(root, 'authority-policy.json');
    const module = pathToFileURL(resolve('packages/authority/src/boundaries/host-publish.ts')).href;
    const script = `import {publishNoReplaceSteps} from ${JSON.stringify(module)};
      process.stdout.write('READY\\n');
      process.stdin.once('data',()=>{try{publishNoReplaceSteps(process.argv[1],process.argv[2]);process.stdout.write('CREATED\\n');}catch(e){process.stdout.write(String(e.code)+'\\n');}process.stdin.destroy();});`;
    function contender(bytes: string) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, target, bytes], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      let readyResolve: (() => void) | undefined;
      const ready = new Promise<void>((done) => {
        readyResolve = done;
      });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('READY\n')) readyResolve?.();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const completed = new Promise<string>((done, fail) => {
        child.once('error', fail);
        child.once('close', (code) =>
          code === 0 ? done(output) : fail(new Error(`${code}: ${errors}`)),
        );
      });
      return { child, ready, completed };
    }
    const first = contender('first exact bytes\n');
    const second = contender('second exact bytes\n');
    try {
      await Promise.all([first.ready, second.ready]);
      expect(fs.readdirSync(root)).toEqual([]);
      first.child.stdin.end('CONFIRM\n');
      second.child.stdin.end('CONFIRM\n');
      const outputs = await Promise.all([first.completed, second.completed]);
      expect(outputs.filter((value) => value.includes('CREATED\n'))).toHaveLength(1);
      expect(outputs.filter((value) => value.includes('EEXIST\n'))).toHaveLength(1);
      const winner = fs.readFileSync(target, 'utf8');
      expect(['first exact bytes\n', 'second exact bytes\n']).toContain(winner);
      expect(fs.readdirSync(root)).toEqual(['authority-policy.json']);
    } finally {
      first.child.kill();
      second.child.kill();
    }
  });

  it('P1-18 preserves a foreign target introduced immediately before publication', () => {
    const root = directory();
    const target = join(root, 'authority-policy.json');
    fs.writeFileSync(target, 'foreign\n');
    const before = fs.lstatSync(target, { bigint: true });
    expect(() => publishNoReplaceSteps(target, 'candidate\n')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('foreign\n');
    expect(fs.lstatSync(target, { bigint: true }).ino).toBe(before.ino);
    expect(fs.readdirSync(root)).toEqual(['authority-policy.json']);
  });

  it.each(['openSync', 'writeSync', 'fsyncSync', 'linkSync'] as const)(
    'P1-19 injected pre-link %s failure leaves no target',
    async (step) => {
      const root = directory();
      const target = join(root, 'authority-policy.json');
      vi.resetModules();
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          [step]: () => {
            throw Object.assign(new Error(`FAULT_${step}`), { code: 'EIO' });
          },
        };
      });
      const subject = await import('../../../authority/src/boundaries/host-publish.js');
      expect(() => subject.publishNoReplaceSteps(target, 'whole\n')).toThrow(`FAULT_${step}`);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  it('P1-19 crash after link retains whole target and owned staging inode without rollback', () => {
    const root = directory();
    const target = join(root, 'authority-policy.json');
    expect(() => publishNoReplaceSteps(target, 'whole\n', { crashAfterLink: true })).toThrow(
      'AUTHORITY_PUBLISH_SIMULATED_CRASH',
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('whole\n');
    const [stage] = fs.readdirSync(root).filter((name) => name.endsWith('.publish-staged'));
    expect(stage).toBeDefined();
    expect(fs.lstatSync(join(root, stage ?? '')).ino).toBe(fs.lstatSync(target).ino);
    expect(() => publishNoReplaceSteps(target, 'different\n')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('whole\n');
  });

  it.each(['unlink', 'directory-fsync'])(
    'P1-19 %s uncertainty retains complete target and reports no durability success',
    (step) => {
      const root = directory();
      const target = join(root, 'authority-policy.json');
      const fail = () => {
        throw Object.assign(new Error('fixture EIO'), { code: 'EIO' });
      };
      expect(() =>
        publishNoReplaceSteps(
          target,
          'whole\n',
          step === 'unlink' ? { unlinkStaged: fail } : { fsyncDirectory: fail },
        ),
      ).toThrow(
        expect.objectContaining({ code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE', path: target }),
      );
      expect(fs.readFileSync(target, 'utf8')).toBe('whole\n');
      expect(() => publishNoReplaceSteps(target, 'retry\n')).toThrow(
        expect.objectContaining({ code: 'EEXIST' }),
      );
    },
  );
});

describe('P1 actual process death publication fixture', () => {
  it('P1-19 SIGKILL after the real link preserves the complete target and owned staged inode', async () => {
    const root = directory();
    const target = join(root, 'authority-policy.json');
    const module = pathToFileURL(resolve('packages/authority/src/boundaries/host-publish.ts')).href;
    const script = `import {publishNoReplaceSteps} from ${JSON.stringify(module)};
      publishNoReplaceSteps(process.argv[1],'complete-killed-process\\n',{unlinkStaged:()=>{process.kill(process.pid,'SIGKILL');}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => done({ code, signal }));
      },
    );
    expect(exit, stderr).toEqual({ code: null, signal: 'SIGKILL' });
    expect(fs.readFileSync(target, 'utf8')).toBe('complete-killed-process\n');
    const stages = fs.readdirSync(root).filter((name) => name.endsWith('.publish-staged'));
    expect(stages).toHaveLength(1);
    expect(fs.lstatSync(join(root, stages[0] ?? '')).ino).toBe(fs.lstatSync(target).ino);
    expect(() => publishNoReplaceSteps(target, 'retry\n')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('complete-killed-process\n');
  });
});
