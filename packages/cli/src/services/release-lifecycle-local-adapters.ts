import type { runCheckTasks } from './check-runner/index.js';
import type { ReleaseLifecycleRequest, ReleaseProvider } from './release-lifecycle-execution.js';

export interface BuiltInReleaseLifecycleLocalContext {
  readonly repo_root: string;
  readonly resolve_receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly resolve_plan_input: (input: Readonly<Record<string, unknown>>) => unknown;
  readonly read_contained_bytes: (path: string) => Buffer;
  readonly run_checks?: typeof runCheckTasks;
}

/** ADR-REL-0016: stock orchestration cannot substitute ambient execution for protected preflight. */
export function builtInReleaseLifecycleLocalProvider(
  _context: BuiltInReleaseLifecycleLocalContext,
  action: ReleaseLifecycleRequest['action_id'],
): ReleaseProvider | undefined {
  return action === 'release preflight'
    ? () => ({ outcome: 'failure', code: 'release-certification-provider-unavailable' })
    : undefined;
}
