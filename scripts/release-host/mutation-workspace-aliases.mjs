import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, readdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';

export function sandboxWorkspaceAliases(root) {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('release-mutation-workspace-entry-invalid');
    if (!entry.isDirectory()) return [];
    const directory = join(packages, entry.name);
    const path = join(directory, 'package.json');
    if (!existsSync(path)) return [];
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof manifest.name !== 'string') return [];
    return Object.entries(manifest.exports ?? {}).flatMap(([subpath, conditions]) => {
      const development = conditions?.development;
      if (typeof development !== 'string') return [];
      if ((subpath !== '.' && !subpath.startsWith('./')) || subpath.includes('*'))
        throw new Error('release-mutation-workspace-export-invalid');
      const target = resolve(directory, development);
      const escaped = relative(directory, target);
      if (
        escaped.startsWith('..') ||
        isAbsolute(escaped) ||
        !existsSync(target) ||
        !lstatSync(target).isFile() ||
        realpathSync(target) !== resolve(realpathSync(directory), development)
      )
        throw new Error('release-mutation-workspace-entry-invalid');
      const specifier = manifest.name + (subpath === '.' ? '' : subpath.slice(1));
      const exact = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [{ find: new RegExp(`^${exact}$`, 'u'), replacement: target }];
    });
  });
}
