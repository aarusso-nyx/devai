import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveNativeLinuxTask,
  parseNativeLinuxPlanInput,
} from '../../src/commands/sense/native-linux-plan.js';
import { replayNativeLinuxTask } from '../../src/commands/sense/native-linux-replay.js';

// Observe effects only. These tests never substitute a plan, native result or standing.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    realpathSync: vi.fn(actual.realpathSync),
    lstatSync: vi.fn(actual.lstatSync),
    accessSync: vi.fn(actual.accessSync),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (platform === undefined) throw new Error('Missing actual platform descriptor');
  Object.defineProperty(process, 'platform', platform);
});
function noEffects() {
  for (const method of [
    fs.readFileSync,
    fs.realpathSync,
    fs.lstatSync,
    fs.accessSync,
    childProcess.execFileSync,
  ])
    expect(method).not.toHaveBeenCalled();
}
function portable() {
  return {
    schemaVersion: '1.0.0',
    nonce: 'a'.repeat(64),
    repository: '/workspace',
    kind: 'unit_test',
    inputs: { taskId: 'test:unit', population: 'complete-unit-population' },
    candidate: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    backendRecordSha256: 'd'.repeat(64),
    snapshotManifestSha256: {
      candidate: 'e'.repeat(64),
      dependencies: 'f'.repeat(64),
      helpers: '1'.repeat(64),
    },
  };
}
function replayInput() {
  const json = JSON.stringify(portable());
  return {
    schemaVersion: '1.0.0',
    nonce: 'a'.repeat(64),
    portableInput: { json, sha256: hash(json) },
    derived: {}, // An authored object cannot replace independent Linux derivation.
    service: { context: {}, exchanges: [] },
    execution: {
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutSha256: hash(''),
      stderrSha256: hash(''),
    },
    trace: { path: '/evidence/trace.jsonl', sha256: '2'.repeat(64) },
  };
}

describe('private Linux plan admission before effects', () => {
  it.each(['unit_test', 'integration_test', 'e2e_test'])(
    'parses only portable %s selection data without effects',
    (kind) => {
      const input = { ...portable(), kind };
      expect(parseNativeLinuxPlanInput(JSON.stringify(input))).toEqual(input);
      noEffects();
    },
  );
  it.each([
    { schemaVersion: '2.0.0' },
    { nonce: 'A'.repeat(64) },
    { nonce: 'a'.repeat(63) },
    { repository: '/other' },
    { kind: 'build' },
    { kind: ['unit_test'] },
    { candidate: 'b'.repeat(64) },
    { tree: '../tree' },
    { backendRecordSha256: 'd'.repeat(63) },
    { inputs: { taskId: '', population: 'all' } },
    { inputs: { taskId: 'task', population: '' } },
    { inputs: { taskId: 'task', population: 'all', argv: ['sh'] } },
    { inputs: { taskId: 'task', population: 'all', cwd: '/tmp' } },
    { snapshotManifestSha256: { candidate: 'a'.repeat(64), dependencies: 'b'.repeat(64) } },
    {
      snapshotManifestSha256: {
        candidate: 'a'.repeat(64),
        dependencies: 'b'.repeat(64),
        helpers: 'c'.repeat(64),
        extra: 'd'.repeat(64),
      },
    },
    { executable: '/bin/sh' },
    { argv: ['--eval', 'owned'] },
    { env: { NODE_OPTIONS: '--require ./other.cjs' } },
  ])('refuses malformed or authority-bearing input %j before effects', (change) => {
    expect(() => parseNativeLinuxPlanInput(JSON.stringify({ ...portable(), ...change }))).toThrow(
      'NATIVE_LINUX_PLAN_INPUT_INVALID',
    );
    noEffects();
  });
  it('refuses malformed JSON and oversized UTF8 before any discovery', () => {
    expect(() => parseNativeLinuxPlanInput('{')).toThrow(SyntaxError);
    expect(() => parseNativeLinuxPlanInput('é'.repeat(32769))).toThrow(
      'NATIVE_LINUX_PLAN_INPUT_TOO_LARGE',
    );
    noEffects();
  });
  it('refuses non-Linux derivation before workspace lookup, tool resolution or resources', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    expect(() => deriveNativeLinuxTask(JSON.stringify(portable()))).toThrow(
      'NATIVE_LINUX_PLAN_RUNTIME_UNSUPPORTED',
    );
    noEffects();
  });
});

describe('private Linux replay admission before effects', () => {
  it.each([
    { schemaVersion: '2.0.0' },
    { nonce: 'g'.repeat(64) },
    { extra: 'authority' },
    { portableInput: { json: '{}', sha256: hash('other') } },
    { portableInput: { json: '{}', sha256: hash('{}'), argv: ['sh'] } },
    { service: { context: {}, exchanges: [], socket: '/other.sock' } },
    { service: { context: {}, exchanges: new Array(1025).fill(null) } },
    { execution: { ...replayInput().execution, status: -1 } },
    { execution: { ...replayInput().execution, status: 256 } },
    { execution: { ...replayInput().execution, status: 0.5 } },
    { execution: { ...replayInput().execution, signal: 'TERM' } },
    { execution: { ...replayInput().execution, stdout: {} } },
    { execution: { ...replayInput().execution, stderrSha256: 'bad' } },
    { trace: { path: '/outside/trace.jsonl', sha256: '2'.repeat(64) } },
    { trace: { path: '/evidence/trace.jsonl', sha256: 'bad' } },
  ])('refuses forged envelope %j before plan derivation or trace access', (change) => {
    expect(() => replayNativeLinuxTask(JSON.stringify({ ...replayInput(), ...change }))).toThrow(
      'NATIVE_LINUX_REPLAY_INPUT_INVALID',
    );
    noEffects();
  });
  it('refuses an oversized raw replay before JSON parsing or filesystem access', () => {
    expect(() => replayNativeLinuxTask(' '.repeat(132 * 1024 * 1024 + 1))).toThrow(
      'NATIVE_LINUX_REPLAY_INPUT_TOO_LARGE',
    );
    noEffects();
  });
  it('cannot use authored plan or successful status to bypass actual Linux derivation', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    expect(() => replayNativeLinuxTask(JSON.stringify(replayInput()))).toThrow(
      'NATIVE_LINUX_PLAN_RUNTIME_UNSUPPORTED',
    );
    noEffects();
  });
});
