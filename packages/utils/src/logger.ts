import { redact, type RedactionPolicy } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMode = 'json' | 'human';

export interface WritableLike {
  write(chunk: string): boolean;
}

export interface LoggerOptions {
  readonly mode?: LogMode;
  readonly level?: LogLevel;
  readonly redaction?: RedactionPolicy;
  readonly out?: WritableLike;
  readonly err?: WritableLike;
  readonly now?: () => string;
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const mode: LogMode = options.mode ?? 'json';
  const threshold = LEVEL_ORDER[options.level ?? 'info'];
  const out: WritableLike = options.out ?? process.stdout;
  const err: WritableLike = options.err ?? process.stderr;
  const now = options.now ?? (() => new Date().toISOString());
  const policy = options.redaction;

  const emit = (
    lvl: LogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const ts = now();
    const safeMessage = policy ? (redact(message, policy) as string) : message;
    const safeFields =
      policy && fields ? (redact(fields, policy) as Record<string, unknown>) : fields;

    if (mode === 'json') {
      const record: Record<string, unknown> = { level: lvl, ts, message: safeMessage };
      if (safeFields) {
        for (const [k, v] of Object.entries(safeFields)) record[k] = v;
      }
      err.write(JSON.stringify(record) + '\n');
    } else {
      const fieldStr =
        safeFields && Object.keys(safeFields).length > 0
          ? ' ' +
            Object.entries(safeFields)
              .map(([k, v]) => `${k}=${formatHumanValue(v)}`)
              .join(' ')
          : '';
      out.write(`[${ts}] ${lvl.toUpperCase()} ${safeMessage}${fieldStr}\n`);
    }
  };

  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
  };
}

function formatHumanValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
