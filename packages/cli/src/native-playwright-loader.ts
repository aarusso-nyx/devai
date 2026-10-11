import { appendFileSync } from 'node:fs';
import type { MessagePort } from 'node:worker_threads';

interface Bootstrap {
  originalUrl: string;
  originalData: unknown;
  preloadUrl: string;
  ownerScope: string;
  childScope: string;
  nonce: string;
  trace: string;
  control: MessagePort;
  acknowledgement: SharedArrayBuffer;
}
interface Hooks {
  initialize?: (data: unknown) => unknown;
  resolve: (...args: unknown[]) => unknown;
  load: (...args: unknown[]) => unknown;
}
let bootstrap: Bootstrap;
let hooks: Hooks | undefined;
let close: () => void;
let active = 0;
let sequence = 0;
let sealRequested = false;
let sealed = false;
const emit = (row: Record<string, unknown>): void => {
  appendFileSync(
    bootstrap.trace,
    `${JSON.stringify({ nonce: bootstrap.nonce, scope: bootstrap.childScope, ...row })}\n`,
  );
};
const seal = (): void => {
  if (!sealRequested || active !== 0 || sealed) return;
  close();
  sealed = true;
  const acknowledgement = new Int32Array(bootstrap.acknowledgement);
  Atomics.store(acknowledgement, 0, 1);
  Atomics.notify(acknowledgement, 0);
  bootstrap.control.close();
};

/** Node awaits this before any original Playwright hook can execute. */
export async function initialize(data: Bootstrap): Promise<void> {
  bootstrap = data;
  if (
    process.env['DEVAI_NATIVE_INPUT_SCOPE'] !== data.ownerScope ||
    process.env['DEVAI_NATIVE_COLLECTION_NONCE'] !== data.nonce ||
    process.env['DEVAI_NATIVE_INPUT_TRACE'] !== data.trace
  )
    throw new Error('NATIVE_LOADER_INHERITED_SCOPE_REFUSED');
  process.env['DEVAI_NATIVE_INPUT_SCOPE'] = data.childScope;
  // Dynamic ordering is essential: static imports would evaluate the original loader first.
  const preload = (await import(data.preloadUrl)) as { sealNativeInputScope(): void };
  close = preload.sealNativeInputScope;
  const original = (await import(data.originalUrl)) as { default?: Hooks } & Hooks;
  hooks = original.default ?? original;
  if (typeof hooks.resolve !== 'function' || typeof hooks.load !== 'function')
    throw new Error('NATIVE_LOADER_HOOKS_INVALID');
  await hooks.initialize?.(data.originalData);
  bootstrap.control.on('message', (message: unknown): void => {
    const request = message as Record<string, unknown>;
    if (
      request['kind'] !== 'seal' ||
      request['nonce'] !== data.nonce ||
      request['childScope'] !== data.childScope
    ) {
      emit({ kind: 'unsupported', operation: 'loader-control-invalid' });
      return;
    }
    sealRequested = true;
    seal();
  });
  bootstrap.control.unref();
  emit({ kind: 'loader-ready' });
}

async function invoke(kind: 'resolve' | 'load', args: unknown[]): Promise<unknown> {
  if (sealed || sealRequested) {
    emit({ kind: 'unsupported', operation: 'sealed-loader-hook' });
    throw new Error('NATIVE_LOADER_SEALED');
  }
  const operation = ++sequence;
  active += 1;
  emit({ kind: 'loader-hook-start', operation, hook: kind });
  try {
    if (hooks === undefined) {
      const next = args.at(-1);
      if (typeof next !== 'function') throw new Error('NATIVE_LOADER_BOOTSTRAP_DELEGATE_INVALID');
      return await next(...args.slice(0, -1));
    }
    return await hooks[kind](...args);
  } finally {
    emit({ kind: 'loader-hook-end', operation, hook: kind });
    active -= 1;
    seal();
  }
}
export async function resolve(...args: unknown[]): Promise<unknown> {
  return invoke('resolve', args);
}
export async function load(...args: unknown[]): Promise<unknown> {
  return invoke('load', args);
}
