import {
  closeReadOnlySync,
  fstatSync,
  lstatSync,
  openReadOnlyNoFollowSync,
  readFileSync,
} from '@devai-nyx/authority';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT_FAIL } from '@devai-nyx/utils';
import type {
  ReleaseLifecycleRequest,
  ReleasePlanInputResolver,
} from '../../services/release-lifecycle-execution.js';
import {
  createResolvedReleasePlanInputResolver,
  type VerifiedReleasePolicyResolution,
} from '../../services/release-policy-resolution.js';

export interface PlanOptions {
  readonly repoRoot?: string;
  readonly intent?: string;
  readonly repository?: string;
  readonly human?: boolean;
}

export interface ResumeOptions {
  readonly request?: string;
  readonly repoRoot?: string;
  readonly stateRoot?: string;
  readonly stateChain?: string;
  readonly storeRecords?: string;
  readonly storeHead?: string;
  readonly receipts?: string;
  readonly publicationReceipt?: string;
  readonly human?: boolean;
}

export interface ActionOptions {
  readonly request?: string;
  readonly repoRoot?: string;
  readonly stateRoot?: string;
  readonly human?: boolean;
}

export interface OfflineVerifyOptions {
  readonly request?: string;
  readonly exportedState?: string;
  readonly repoRoot?: string;
  readonly human?: boolean;
}

function sameFileSnapshot(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readPinnedBytes(path: string): Buffer {
  const absolute = resolve(path);
  const before = lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('release-receipt-path-unsafe');
  }
  const descriptor = openReadOnlyNoFollowSync(absolute);
  try {
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || !sameFileSnapshot(before, openedBefore)) {
      throw new Error('release-receipt-path-unsafe');
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (!sameFileSnapshot(openedBefore, openedAfter) || !sameFileSnapshot(openedAfter, after)) {
      throw new Error('release-receipt-path-unsafe');
    }
    return bytes;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function assertDirectoryChain(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const relativePath = relative(absoluteRoot, candidate);
  let cursor = absoluteRoot;
  for (const part of relativePath.split(sep).slice(0, -1)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('release-receipt-path-unsafe');
    }
  }
}

export function readContainedBytes(root: string, path: string): Buffer {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, path);
  const escaped = relative(absoluteRoot, candidate);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error('release-receipt-path-unsafe');
  }
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('release-receipt-path-unsafe');
  }
  assertDirectoryChain(absoluteRoot, candidate);
  return readPinnedBytes(candidate);
}

export function readPinnedJson(path: string): unknown {
  return JSON.parse(readPinnedBytes(path).toString('utf8')) as unknown;
}

function readContainedJson(root: string, path: string): unknown {
  return JSON.parse(readContainedBytes(root, path).toString('utf8')) as unknown;
}

export function localResolvers(
  root: string,
  resolution?: VerifiedReleasePolicyResolution | readonly VerifiedReleasePolicyResolution[],
): {
  readonly receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly plan: ReleasePlanInputResolver;
} {
  return {
    receipt: (locator) => readContainedJson(root, locator.path),
    plan:
      resolution === undefined
        ? () => {
            throw new Error('rpl-policy-source-unresolved');
          }
        : createResolvedReleasePlanInputResolver(resolution),
  };
}

export function fail(action: string, code: string, detail: string, exit = EXIT_FAIL): void {
  process.stderr.write(`devai ${action}: ${code}: ${detail}\n`);
  process.exitCode = exit;
}

/** Never echo native read/JSON errors: their messages may include host paths or input bytes. */
export function inputFailureCode(error: unknown, fallback: string): string {
  const codes = new Set([
    'rpl-policy-source-unresolved',
    'rpl-package-identity-mismatch',
    'rpl-adopter-binding-mismatch',
    'rpl-policy-resolution-mismatch',
    'rpl-legacy-plan-non-authoritative',
    'rpl-input-unresolved',
    'release-receipt-path-unsafe',
    'release-request-projection-invalid',
    'release-request-action-mismatch',
    'release-request-identity-mismatch',
    'release-request-receipt-order-invalid',
    'release-receipt-identity-mismatch',
    'release-release-unit-bijection-invalid',
    'release-offline-state-missing',
    'release-offline-state-mismatch',
    'release-state-store-unsafe',
  ]);
  return error instanceof Error && codes.has(error.message) ? error.message : fallback;
}
