import type { RegistryEntry } from './define-command.js';

const DOMAIN_SUMMARIES: Readonly<Record<string, string>> = {
  audit: 'Create exact, non-promoting Auditor observations.',
  catalog: 'Inspect the live action catalog.',
  check: 'Run governed validation suites and checks.',
  doctor: 'Diagnose the declared adoption posture.',
  evidence: 'Record, render, redact, and verify audit evidence.',
  init: 'Install and bind DEVAI in a repository.',
  release: 'Check and verify releases.',
  round: 'Plan, run, assess, and close governed rounds.',
  sense: 'Observe repository and runtime state through sensors.',
  task: 'Operate round-bound task plumbing.',
  triage: 'Classify sensor failures before remediation.',
};

const DEFAULT_DOMAIN_ORDER = [
  'audit',
  'init',
  'doctor',
  'check',
  'sense',
  'round',
  'evidence',
  'release',
  'triage',
] as const;

const EXPANDED_DOMAIN_ORDER = [...DEFAULT_DOMAIN_ORDER, 'task', 'catalog'] as const;

export function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function renderRows(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.min(32, Math.max(...rows.map(([name]) => name.length), 0));
  return rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`);
}

export function renderHelp(
  entries: readonly RegistryEntry[],
  version: string,
  prefix: readonly string[] = [],
  includeAll = false,
): string {
  const visible = entries.filter(
    (entry) =>
      startsWithPath(entry.path, prefix) &&
      (includeAll || entry.tier === 'porcelain' || entry.path.length === prefix.length),
  );
  const lines = [`devai/${version}`, ''];
  lines.push(`Usage: devai${prefix.length > 0 ? ` ${prefix.join(' ')}` : ''} <command> [options]`);
  lines.push('');
  if (prefix.length === 0) {
    lines.push('Domains:');
    const domains = includeAll ? EXPANDED_DOMAIN_ORDER : DEFAULT_DOMAIN_ORDER;
    lines.push(
      ...renderRows(
        domains.map((domain) => [domain, DOMAIN_SUMMARIES[domain] ?? 'DEVAI command domain.']),
      ),
    );
  } else {
    const exact = visible.find((entry) => entry.path.length === prefix.length);
    if (exact !== undefined) {
      lines[2] = `Usage: devai ${exact.name}${exact.runtime_args === undefined || exact.runtime_args.length === 0 ? '' : ` ${exact.runtime_args}`} [options]`;
      lines.push(exact.description);
      lines.push('');
      lines.push(`Lifecycle: ${exact.lifecycle}`);
      lines.push(`Authority: ${exact.authority}`);
      lines.push(`Effects: ${exact.effects}`);
      if ((exact.runtime_options?.length ?? 0) > 0) {
        lines.push('');
        lines.push('Options:');
        lines.push(
          ...renderRows(
            (exact.runtime_options ?? []).map((option) => [option.flags, option.description]),
          ),
        );
      }
    }
    const children = new Map<string, string>();
    for (const entry of visible) {
      const child = entry.path[prefix.length];
      if (child === undefined) continue;
      const isLeaf = entry.path.length === prefix.length + 1;
      children.set(
        child,
        isLeaf
          ? entry.description
          : prefix.length === 0
            ? (DOMAIN_SUMMARIES[child] ?? `${child} commands.`)
            : `${child} commands.`,
      );
    }
    if (children.size > 0) {
      lines.push('Commands:');
      lines.push(
        ...renderRows(Array.from(children.entries()).sort(([a], [b]) => a.localeCompare(b))),
      );
    }
  }
  lines.push('');
  if (prefix.length === 0 || visible.every((entry) => entry.path.length !== prefix.length)) {
    lines.push('Options:');
    lines.push('  --help       Show help for this command path.');
    lines.push('  --all        Include plumbing commands in help.');
    lines.push('  --version    Show the DEVAI CLI version.');
  }
  lines.push('');
  return lines.join('\n');
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[b.length] ?? Math.max(a.length, b.length);
}

export function suggestion(
  input: readonly string[],
  entries: readonly RegistryEntry[],
): string | undefined {
  const wanted = input.join(' ');
  const candidate = entries
    .map((entry) => entry.path.join(' '))
    .sort((a, b) => distance(wanted, a) - distance(wanted, b))[0];
  if (candidate === undefined) return undefined;
  const editDistance = distance(wanted, candidate);
  const maximum = Math.max(1, Math.floor(Math.max(wanted.length, candidate.length) * 0.34));
  return editDistance <= maximum ? candidate : undefined;
}
