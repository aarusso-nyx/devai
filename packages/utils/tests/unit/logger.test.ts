import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.useRealTimers());

describe('logger output contracts', () => {
  it('uses the current ISO timestamp when no clock is injected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TS));
    const err = makeMockStream();
    createLogger({ err: err.stream }).error('failed');
    expect(err.output()).toBe(
      JSON.stringify({ level: 'error', ts: FIXED_TS, message: 'failed' }) + '\n',
    );
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'emits exactly the levels at or above %s',
    (level) => {
      const err = makeMockStream();
      const log = createLogger({ err: err.stream, level, now });
      const levels = ['debug', 'info', 'warn', 'error'] as const;
      for (const name of levels) log[name](name);
      expect(err.output()).toBe(
        levels
          .slice(levels.indexOf(level))
          .map((name) => JSON.stringify({ level: name, ts: FIXED_TS, message: name }) + '\n')
          .join(''),
      );
    },
  );

  it('separates human fields, represents nullish and structured values, and omits empty fields', () => {
    const out = makeMockStream();
    const log = createLogger({ mode: 'human', out: out.stream, now });
    log.error('failure', {
      text: 'value',
      nil: null,
      missing: undefined,
      object: { a: 1 },
      array: [1, false],
    });
    log.info('empty', {});
    expect(out.output()).toBe(
      `[${FIXED_TS}] ERROR failure text=value nil=null missing=undefined object={"a":1} array=[1,false]\n[${FIXED_TS}] INFO empty\n`,
    );
  });

  it('redacts human messages and nested field values before writing without changing caller data', () => {
    const out = makeMockStream();
    const fields = { token: 'private', detail: { key: 'sk-secret' } };
    const log = createLogger({
      mode: 'human',
      out: out.stream,
      now,
      redaction: { patterns: [/sk-[a-z]+/g], fields: ['token'] },
    });
    log.info('using sk-secret', fields);
    expect(out.output()).toBe(
      `[${FIXED_TS}] INFO using [REDACTED] token=[REDACTED] detail={"key":"[REDACTED]"}\n`,
    );
    expect(fields).toEqual({ token: 'private', detail: { key: 'sk-secret' } });
  });
});
