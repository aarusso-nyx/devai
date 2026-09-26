import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Token-shaped values and secret-named assignments. Mirrors the runner's
// redaction (packages/cli/src/services/check-runner/preflight.ts) so a value
// that reached a diagnostic file by any path is still masked when printed.
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  /\bnpm_[A-Za-z0-9]{20,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{8,}/gu,
  /_authToken=\S+/gu,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=\S+/gu,
];

export function redactDiagnosticText(value) {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '[REDACTED]'),
    String(value ?? ''),
  );
}

function remediationOf(value) {
  return Array.isArray(value) && value.length > 0
    ? value.map((entry) => redactDiagnosticText(entry))
    : undefined;
}

/**
 * PR tasks receive no protected inputs. Show their bounded, redacted failure
 * tails in CI, and render a BLOCKED probe node with its remediation.
 */
export function prFailureDiagnostics(root, execution = []) {
  const directory = join(realpathSync(root), '.devai/state/check-cache/v1/diagnostics');
  return execution
    .filter((task) => task.outcome !== 'PASS')
    .map((task) => {
      const remediation = remediationOf(task.remediation);
      const result = {
        nodeId: task.nodeId,
        outcome: task.outcome,
        reason: task.reason === undefined ? undefined : redactDiagnosticText(task.reason),
        ...(remediation !== undefined && { remediation }),
      };
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
        const fileRemediation = remediation ?? remediationOf(diagnostic.remediation);
        return {
          ...result,
          ...(fileRemediation !== undefined && { remediation: fileRemediation }),
          stdoutTail: redactDiagnosticText(String(diagnostic.stdoutTail ?? '').slice(-8192)),
          stderrTail: redactDiagnosticText(String(diagnostic.stderrTail ?? '').slice(-8192)),
        };
      } catch {
        return { ...result, diagnostic: 'unavailable' };
      }
    });
}
