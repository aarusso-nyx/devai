// ADR-AUT-0005 in the loop: create-only records publish without replacement (#287), and an
// authorized init step durably initializes the .devai/state root (#293).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PUBLISH_INDETERMINATE,
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flushes = vi.hoisted(() => [] as string[]);
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    flushDirectoryEntrySync: (path: string) => {
      flushes.push(path);
      actual.flushDirectoryEntrySync(path);
    },
  };
});
import {
  PublicationIndeterminate,
  publishCreateOnlyDurableSync,
  writeCreateOnlyDurableSync,
} from '../../src/loop/durable-files.js';
import {
  EXPERIMENTAL_ACTIVATION_LOCK,
  withdrawExperimentalActivation,
} from '../../src/loop/experimental-activation.js';
import {
  STATE_ROOT_MARKER,
  STATE_ROOT_MARKER_BODY,
  initializeStateRootSync,
  stateRootInitialized,
  stateRootMarkerStatus,
} from '../../src/loop/state-root.js';

let root: string;
let requests: AuthorityHostEffectRequest[];
let beforePublish: ((request: AuthorityHostEffectRequest) => void) | undefined;
/** Fault injection: this publication links its target, then its cleanup fails. */
let indeterminatePath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-durable-publication-'));
  requests = [];
  beforePublish = undefined;
  indeterminatePath = undefined;
  flushes.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'durable-publication-test',
    issuer_version: '1.0.0',
    invocation_id: 'durable-publication',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'durable-publication-receipt',
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30000,
  });
  try {
    return runWithAuthorityHostEffects(
      {
        action_id: 'durable publication acceptance',
        invocation_id: 'durable-publication',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (request, apply) => {
          requests.push(request);
          if (request.symbol === 'publishFileNoReplaceSync' && beforePublish !== undefined) {
            const interleaved = beforePublish;
            beforePublish = undefined;
            interleaved(request);
          }
          if (
            request.symbol === 'publishFileNoReplaceSync' &&
            request.arguments[0] === indeterminatePath
          ) {
            indeterminatePath = undefined;
            apply();
            throw Object.assign(new Error(PUBLISH_INDETERMINATE), { code: PUBLISH_INDETERMINATE });
          }
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

describe('create-only durable records', () => {
  it('publishes through the governed no-replace effect', () => {
    const path = join(root, '.devai/state/records/R-1.json');
    run(() => writeCreateOnlyDurableSync(path, 'one\n'));
    expect(readFileSync(path, 'utf8')).toBe('one\n');
    expect(requests.filter((request) => request.symbol === 'publishFileNoReplaceSync')).toEqual([
      { kind: 'filesystem', symbol: 'publishFileNoReplaceSync', arguments: [path, 'one\n'] },
    ]);
    expect(requests.some((request) => request.symbol === 'renameSync')).toBe(false);
    expect(readdirSync(join(root, '.devai/state/records'))).toEqual(['R-1.json']);
  });

  it('lets exactly one of two racing writers create the record, never replacing it', () => {
    const path = join(root, '.devai/state/records/R-2.json');
    let refusal: unknown;
    run(() => {
      // The racer publishes after the first writer passed every check but before its link.
      beforePublish = () => writeCreateOnlyDurableSync(path, 'racer\n');
      try {
        writeCreateOnlyDurableSync(path, 'first\n');
      } catch (error) {
        refusal = error;
      }
    });
    expect(refusal).toMatchObject({ message: 'DURABLE_RECORD_EXISTS' });
    expect(readFileSync(path, 'utf8')).toBe('racer\n');
    expect(readdirSync(join(root, '.devai/state/records'))).toEqual(['R-2.json']);
  });

  it('reports an existing exclusive record as not created', () => {
    const path = join(root, '.devai/state/lock.json');
    expect(run(() => publishCreateOnlyDurableSync(path, 'held\n'))).toBe(true);
    expect(run(() => publishCreateOnlyDurableSync(path, 'other\n'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('held\n');
  });
});

describe('indeterminate publications', () => {
  it('never reports a create-only record whose cleanup failed as created', () => {
    const path = join(root, '.devai/state/records/R-3.json');
    indeterminatePath = path;
    let failure: unknown;
    run(() => {
      try {
        writeCreateOnlyDurableSync(path, 'bytes\n');
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(PublicationIndeterminate);
    expect(failure).toMatchObject({ code: 'DURABLE_PUBLICATION_INDETERMINATE', path });
    // The bytes are in place; a retry refuses rather than replacing them.
    expect(readFileSync(path, 'utf8')).toBe('bytes\n');
    expect(() => run(() => writeCreateOnlyDurableSync(path, 'again\n'))).toThrow(
      'DURABLE_RECORD_EXISTS',
    );
  });

  it('removes its own activation lock when the lock publication is indeterminate', () => {
    const lock = join(root, EXPERIMENTAL_ACTIVATION_LOCK);
    indeterminatePath = lock;
    expect(() => run(() => withdrawExperimentalActivation({ repoRoot: root }))).toThrow(
      'DURABLE_PUBLICATION_INDETERMINATE',
    );
    expect(existsSync(lock)).toBe(false);
  });
});

describe('durable state root initialization', () => {
  it('fsyncs .devai, publishes the marker once, and keeps it on re-application', () => {
    mkdirSync(join(root, '.devai'));
    expect(stateRootInitialized(root)).toBe(false);
    const first = run(() => initializeStateRootSync(root));
    expect(first).toEqual({ created: true, path: join(root, STATE_ROOT_MARKER) });
    expect(stateRootInitialized(root)).toBe(true);
    // The directory that holds the state root's own entry is opened and fsynced.
    const devai = resolve(root, '.devai');
    const opened = requests.findIndex(
      (request) => request.symbol === 'openSync' && request.arguments[0] === devai,
    );
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(requests[opened + 1]?.symbol).toBe('fsyncSync');
    const marker = readFileSync(first.path, 'utf8');
    expect(marker).toBe(STATE_ROOT_MARKER_BODY);
    expect(JSON.parse(marker)).toEqual({ schemaVersion: '1.0.0', id: 'state-root' });
    const again = run(() => initializeStateRootSync(root));
    expect(again.created).toBe(false);
    expect(readFileSync(first.path, 'utf8')).toBe(marker);
  });

  it('creates a missing state root before publishing the marker', () => {
    mkdirSync(join(root, '.devai'));
    run(() => initializeStateRootSync(root));
    expect(existsSync(join(root, '.devai/state'))).toBe(true);
    expect(stateRootInitialized(root)).toBe(true);
  });

  it('fsyncs the repository directory only when it creates .devai', () => {
    run(() => initializeStateRootSync(root));
    expect(flushes).toEqual([root]);
    expect(stateRootInitialized(root)).toBe(true);
    flushes.length = 0;
    rmSync(join(root, '.devai/state'), { recursive: true });
    run(() => initializeStateRootSync(root));
    expect(flushes).toEqual([]);
  });

  it.each([
    ['other bytes', () => writeFileSync(join(root, STATE_ROOT_MARKER), '{"id":"state-root"}\n')],
    ['a directory', () => mkdirSync(join(root, STATE_ROOT_MARKER))],
    [
      'a symbolic link to the exact bytes',
      () => {
        writeFileSync(join(root, 'elsewhere.json'), STATE_ROOT_MARKER_BODY);
        symlinkSync(join(root, 'elsewhere.json'), join(root, STATE_ROOT_MARKER));
      },
    ],
  ])('treats %s at the marker path as invalid and refuses to initialize over it', (_, plant) => {
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    plant();
    expect(stateRootMarkerStatus(root)).toBe('invalid');
    expect(stateRootInitialized(root)).toBe(false);
    expect(() => run(() => initializeStateRootSync(root))).toThrow(
      'INIT_STATE_ROOT_MARKER_INVALID',
    );
    expect(stateRootMarkerStatus(root)).toBe('invalid');
  });
});
