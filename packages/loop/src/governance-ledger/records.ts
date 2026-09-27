import { readFileSync } from 'node:fs';

export interface GovernanceFinding {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface GovernanceIntegrityReport {
  readonly ok: boolean;
  readonly findings: readonly GovernanceFinding[];
}

export interface ParsedGovernanceRecord {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly source: string;
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      // Generated inline arrays use JSON quoting, including embedded separators.
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Retain the existing bare-word and semicolon-separated YAML subset.
    }
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(/[;,]/u).map((item) => scalar(item));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        // Non-JSON quoted forms retain the existing subset interpretation.
      }
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?[0-9]+$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseYamlSubset(source: string): Record<string, unknown> {
  const lines = source
    .split('\n')
    .map((raw) => ({
      raw,
      indent: raw.length - raw.trimStart().length,
      text: raw.trim(),
    }))
    .filter((line) => line.text.length > 0 && !line.text.startsWith('#'));

  function parseObject(start: number, indent: number): [Record<string, unknown>, number] {
    const result = Object.create(null) as Record<string, unknown>;
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent || line.text.startsWith('- ')) break;
      const colon = line.text.indexOf(':');
      if (colon < 1) {
        index += 1;
        continue;
      }
      const key = line.text.slice(0, colon).trim();
      const value = line.text.slice(colon + 1).trim();
      if (value.length > 0) {
        result[key] = scalar(value);
        index += 1;
        continue;
      }
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        result[key] = {};
        index += 1;
      } else if (next.text.startsWith('- ')) {
        const [items, nextIndex] = parseArray(index + 1, next.indent);
        result[key] = items;
        index = nextIndex;
      } else {
        const [child, nextIndex] = parseObject(index + 1, next.indent);
        result[key] = child;
        index = nextIndex;
      }
    }
    return [result, index];
  }

  function parseArray(start: number, indent: number): [unknown[], number] {
    const result: unknown[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent !== indent || !line.text.startsWith('- ')) break;
      const item = line.text.slice(2).trim();
      if (item.includes(':')) {
        const colon = item.indexOf(':');
        const object = Object.create(null) as Record<string, unknown>;
        object[item.slice(0, colon).trim()] = scalar(item.slice(colon + 1).trim());
        index += 1;
        while (index < lines.length) {
          const nested = lines[index];
          if (nested === undefined || nested.indent <= indent) break;
          const nestedColon = nested.text.indexOf(':');
          if (nestedColon < 1) {
            index += 1;
            continue;
          }
          const key = nested.text.slice(0, nestedColon).trim();
          const value = nested.text.slice(nestedColon + 1).trim();
          if (value.length > 0) {
            object[key] = scalar(value);
            index += 1;
          } else {
            const after = lines[index + 1];
            if (after === undefined || after.indent <= nested.indent) {
              object[key] = {};
              index += 1;
            } else if (after.text.startsWith('- ')) {
              const [items, nextIndex] = parseArray(index + 1, after.indent);
              object[key] = items;
              index = nextIndex;
            } else {
              const [child, nextIndex] = parseObject(index + 1, after.indent);
              object[key] = child;
              index = nextIndex;
            }
          }
        }
        result.push(object);
      } else {
        result.push(scalar(item));
        index += 1;
      }
    }
    return [result, index];
  }

  return parseObject(0, lines[0]?.indent ?? 0)[0];
}

export function parseGovernanceRecord(path: string): ParsedGovernanceRecord {
  const source = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/u.exec(source);
  if (match === null) {
    throw new Error('frontmatter is required');
  }
  return {
    path,
    frontmatter: parseYamlSubset(match[1] ?? ''),
    body: source.slice(match[0].length),
    source,
  };
}

export function parseRecordSource(path: string, source: string): ParsedGovernanceRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/u.exec(source);
  if (match === null) throw new Error('frontmatter is required');
  return {
    path,
    frontmatter: parseYamlSubset(match[1] ?? ''),
    body: source.slice(match[0].length),
    source,
  };
}
