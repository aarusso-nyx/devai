import { execFileSync } from 'node:child_process';

/**
 * Turns off Git auto-maintenance in a temporary repository fixture the caller just created.
 *
 * Every `git commit` otherwise starts `git maintenance run --auto --detach`, a background
 * process that takes `.git/objects/maintenance.lock` after the commit returns. Under load it
 * outlives the test and races the recursive teardown of the temporary directory, which then
 * fails with `ENOTEMPTY` (#246). The fixture owns its repository, so the setting is local to
 * it and changes nothing the code under test observes.
 */
export function disableGitAutoMaintenance(root: string): void {
  for (const [name, value] of [
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
  ] as const) {
    execFileSync('git', ['config', name, value], { cwd: root, stdio: 'ignore' });
  }
}
