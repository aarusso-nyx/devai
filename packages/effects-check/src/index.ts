import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { unwrapExpression } from './program.js';
export { analyzeEffectProgram, validateDeclaredCapabilityConsistency } from './analyze.js';
export type {
  ActionEffectAnalysis,
  EffectCapability,
  EffectContract,
  EffectDisposition,
  EffectFinding,
  EffectReport,
  SubprocessTemplate,
} from './analyze.js';

export { ACTION_EFFECT_CONTRACTS } from './generated/action-catalog.js';

const BINDING_FINDINGS = new Set([
  'EFFECT_UNDER_DECLARED',
  'SPAWN_EFFECT_UNDECLARED',
  'EFFECT_EDGE_UNRESOLVED',
  'EFFECT_EXTRACTOR_CATALOG_MISMATCH',
  'EFFECT_CAPABILITIES_MISSING',
  'EFFECT_CONTRACT_MISSING',
]);

export function enforceEffectReport(input: {
  readonly findings: readonly Readonly<{
    code: string;
    action_id?: string;
    message: string;
  }>[];
}): void {
  const blocking = input.findings.filter((finding) => BINDING_FINDINGS.has(finding.code));
  if (blocking.length === 0) return;
  throw new Error(
    blocking
      .map(
        (finding) =>
          `${finding.code}${finding.action_id === undefined ? '' : `:${finding.action_id}`}`,
      )
      .join('\n'),
  );
}

export function parseActionEffectsSource(source: string): Readonly<Record<string, string>> {
  const file = ts.createSourceFile('command-manifest.ts', source, ts.ScriptTarget.Latest, true);
  const result: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ACTION_EFFECTS' &&
      node.initializer !== undefined
    ) {
      const value = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteralLike(property.name)
              ? property.name.text
              : undefined;
          const initializer = unwrapExpression(property.initializer);
          if (key !== undefined && ts.isStringLiteralLike(initializer)) {
            result[key] = initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
