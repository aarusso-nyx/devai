import { describe, expect, it } from 'vitest';
import { createLogger, type WritableLike } from '../../src/logger.js';

function makeMockStream(): { stream: WritableLike; output: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    },
    output: () => chunks.join(''),
  };
}

const FIXED_TS = '2026-05-11T00:00:00.000Z';
const now = (): string => FIXED_TS;

describe('createLogger json mode', () => {
  it('writes JSON line to err stream by default', () => {
    const out = makeMockStream();
    const err = makeMockStream();
    const log = createLogger({ out: out.stream, err: err.stream, now });
    log.info('hello', { task: 'TASK-0001' });
    expect(out.output()).toBe('');
    const parsed = JSON.parse(err.output().trim()) as Record<string, unknown>;
    expect(parsed).toEqual({
      level: 'info',
      ts: FIXED_TS,
      message: 'hello',
      task: 'TASK-0001',
    });
  });

  it('respects the level threshold (debug suppressed at info)', () => {
    const err = makeMockStream();
    const log = createLogger({ err: err.stream, level: 'info', now });
    log.debug('quiet');
    log.info('loud');
    const parsed = JSON.parse(err.output().trim()) as Record<string, unknown>;
    expect(parsed.message).toBe('loud');
  });

  it('emits debug when level is debug', () => {
    const err = makeMockStream();
    const log = createLogger({ err: err.stream, level: 'debug', now });
    log.debug('audible');
    const parsed = JSON.parse(err.output().trim()) as Record<string, unknown>;
    expect(parsed.level).toBe('debug');
    expect(parsed.message).toBe('audible');
  });
});

describe('createLogger human mode', () => {
  it('writes human-readable line to out stream with fields', () => {
    const out = makeMockStream();
    const err = makeMockStream();
    const log = createLogger({ mode: 'human', out: out.stream, err: err.stream, now });
    log.warn('careful', { count: 3 });
    expect(err.output()).toBe('');
    expect(out.output()).toBe(`[${FIXED_TS}] WARN careful count=3\n`);
  });

  it('omits the field block when no fields are provided', () => {
    const out = makeMockStream();
    const log = createLogger({ mode: 'human', out: out.stream, now });
    log.info('plain');
    expect(out.output()).toBe(`[${FIXED_TS}] INFO plain\n`);
  });
});

describe('createLogger redaction', () => {
  it('redacts fields and pattern matches in both message and field values', () => {
    const err = makeMockStream();
    const log = createLogger({
      err: err.stream,
      now,
      redaction: { patterns: [/sk-[a-z0-9]+/g], fields: ['token'] },
    });
    log.info('using key sk-xyz', { token: 'abc', user: 'alice' });
    const parsed = JSON.parse(err.output().trim()) as Record<string, unknown>;
    expect(parsed.message).toBe('using key [REDACTED]');
    expect(parsed.token).toBe('[REDACTED]');
    expect(parsed.user).toBe('alice');
  });
});
// Invariants: INV-DEVAI-001
