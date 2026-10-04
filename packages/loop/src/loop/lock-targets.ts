/** The task fields that name its resource-lock keys. */
export interface LockTargetSource {
  readonly target_substrates: readonly string[];
  readonly target_modules: readonly string[];
}

/** UTF-8 byte order, the canonical lock acquisition order of `round-execution.json`. */
export function utf8Compare(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b));
}

/**
 * Every `substrate:module` key a task must hold, deduplicated and in UTF-8 order.
 * A task with no module target holds no module lock (`task.schema.json`).
 */
export function taskLockTargets(task: LockTargetSource): readonly string[] {
  return [
    ...new Set(task.target_substrates.flatMap((s) => task.target_modules.map((m) => `${s}:${m}`))),
  ].sort(utf8Compare);
}
