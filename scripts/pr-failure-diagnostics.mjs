import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** PR tasks receive no protected inputs. Show their bounded failure tails in CI. */
export function prFailureDiagnostics(root, execution = []) {
  const directory = join(realpathSync(root), '.devai/state/check-cache/v1/diagnostics');
  return execution
    .filter((task) => task.outcome !== 'PASS')
    .map((task) => {
      const result = { nodeId: task.nodeId, outcome: task.outcome, reason: task.reason };
      try {
        const path = task.diagnosticPath;
        if (typeof path !== 'string' || dirname(path) !== directory) throw new Error('path');
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 64 * 1024 || realpathSync(path) !== path) {
          throw new Error('file');
        }
        const diagnostic = JSON.parse(readFileSync(path, 'utf8'));
        if (diagnostic.nodeId !== task.nodeId || diagnostic.taskKey !== task.taskKey) {
          throw new Error('binding');
        }
        return {
          ...result,
          stdoutTail: String(diagnostic.stdoutTail ?? '').slice(-8192),
          stderrTail: String(diagnostic.stderrTail ?? '').slice(-8192),
        };
      } catch {
        return { ...result, diagnostic: 'unavailable' };
      }
    });
}
