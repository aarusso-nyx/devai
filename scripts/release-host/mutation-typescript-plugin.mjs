import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Loaded only from the protected host program mount. Candidate configuration
// cannot select the package, checker implementation, or timestamp policy.
const require = createRequire('/workspace/candidate/package.json');
const checkerPackage = dirname(require.resolve('@stryker-mutator/typescript-checker/package.json'));
const checkerRequire = createRequire(join(checkerPackage, 'package.json'));
const checkerManifest = JSON.parse(readFileSync(join(checkerPackage, 'package.json'), 'utf8'));
const typescriptManifest = JSON.parse(
  readFileSync(checkerRequire.resolve('typescript/package.json'), 'utf8'),
);
if (checkerManifest.version !== '9.6.1' || typescriptManifest.version !== '5.9.3') {
  throw new Error('devai-mutation-typescript-plugin-toolchain-invalid');
}

const scriptFileModule = await import(
  pathToFileURL(join(checkerPackage, 'dist/src/fs/script-file.js')).href
);
const typescriptModule = await import(pathToFileURL(checkerRequire.resolve('typescript')).href);
const typescript = typescriptModule.default ?? typescriptModule;
const { ScriptFile } = scriptFileModule;
if (
  typeof ScriptFile !== 'function' ||
  typeof ScriptFile.prototype.touch !== 'function' ||
  typeof typescript.FileWatcherEventKind?.Changed !== 'number'
) {
  throw new Error('devai-mutation-typescript-plugin-api-invalid');
}

// ScriptFile.touch() uses new Date() and can reuse a timestamp during rapid
// checker mutations. Keep the actual Changed callback and all checker results;
// only make modifiedTime strictly increasing per protected process.
let monotonicTick = 0;
ScriptFile.prototype.touch = function () {
  const previous = this.modifiedTime instanceof Date ? this.modifiedTime.getTime() : 0;
  const next = Math.max(Date.now(), monotonicTick, previous) + 1;
  this.modifiedTime = new Date(next);
  monotonicTick = next;
  this.watcher?.(this.fileName, typescript.FileWatcherEventKind.Changed);
};

const checkerIndex = await import(pathToFileURL(join(checkerPackage, 'dist/src/index.js')).href);

// Preserve the pinned checker factory, public checker name, and validation
// schema exactly. This adapter changes no grouping, roster, threshold, or
// result semantics.
export const strykerPlugins = checkerIndex.strykerPlugins;
export const strykerValidationSchema = checkerIndex.strykerValidationSchema;
export const createTypescriptChecker = checkerIndex.createTypescriptChecker;
