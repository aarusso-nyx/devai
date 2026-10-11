// ADR-SCR-0018: workflow inspection never executes the source being inventoried.
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const hash = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

export function workflow(run = 'node scripts/main.mjs'): string {
  return `name: Inspection\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Inspect\n        run: ${run}\n`;
}

export function populate(root: string): void {
  put(root, 'package.json', '{"type":"module","scripts":{"audit":"node scripts/main.mjs"}}\n');
  put(
    root,
    'scripts/main.mjs',
    "import './leaf.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('EXECUTED', 'must never execute');\n",
  );
  put(root, 'scripts/leaf.mjs', 'export const value = 1;\n');
  put(root, '.github/workflows/check.yml', workflow());
}

/** Include every file/directory/link and mode, without unstable access timestamps. */
export function snapshot(root: string): readonly string[] {
  const rows: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      const mode = String(stat.mode & 0o777);
      if (stat.isSymbolicLink()) rows.push(`${path}:link:${mode}:${readlinkSync(absolute)}`);
      else if (stat.isDirectory()) {
        rows.push(`${path}:directory:${mode}`);
        walk(absolute, path);
      } else rows.push(`${path}:file:${mode}:${hash(readFileSync(absolute))}`);
    }
  };
  walk(root, '');
  return rows;
}
