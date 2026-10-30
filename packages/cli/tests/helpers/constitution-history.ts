import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const CURRENT_DOCUMENTATION_CONSTITUTION_SHA256 =
  '4dbb9caa8961cf3bbf8070faf7525711b018b1aaa3b47b17ae9a85f55cf4b57c';
export function frozenReconciliationConstitution(): string {
  const text = readFileSync(
    resolve(
      ROOT,
      'packages/cli/tests/fixtures/documentation-authority-current-main-baseline/canonical/law/constitution.md.txt',
    ),
    'utf8',
  );
  expect(sha256(text)).toBe('d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a');
  return text;
}
/** Reverse only accepted AUT-0009; retain the entire exact 1.2.0 contract. */
export function projectReconciliationConstitution(text: string): string {
  const historical = frozenReconciliationConstitution();
  if (text === historical) return historical;
  expect(sha256(text)).toBe(CURRENT_DOCUMENTATION_CONSTITUTION_SHA256);
  const result = text
    .replace('title: DEVAI Constitution 1.2.1', 'title: DEVAI Constitution 1.2.0')
    .replace('# DEVAI Constitution — 1.2.1', '# DEVAI Constitution — 1.2.0')
    .replace('**Version:** 1.2.1', '**Version:** 1.2.0')
    .replace('date: 2026-10-25', 'date: 2026-10-24')
    .replace(
      'Core authority is decided by a fixed path prefix of at most two segments, with only the explicitly defined documentation-implementation specialization below using finite exact file identities. No wildcard remainder or inferred file-presence rule may create authority:',
      'Core authority is decided by a fixed path prefix of at most two segments — a table lookup, never a wildcard rule with a default remainder:',
    )
    .replace(
      '- `docs/` — Architect (published human documentation), except the finite executable implementation files admitted by the documentation-implementation specialization below; those files are Engineer-owned. Test and architectural-specification authority is never transferred by this specialization.',
      '- `docs/` — Architect (published human documentation).',
    )
    .replace(
      'Documentation implementation is a package-defined core specialization, not an additive extension or an exemption from Article 10. A newer canonical constitution and authority implementation may admit an explicit, finite list of repository-relative executable implementation files under `docs/`, from a versioned Architect-authored policy source approved for that exact list and bound through a registered initialization action. Entries are exact normalized file paths, never roots, directories, wildcards, prefixes or inferred extension-wide grants. Protected tests and architecture/specification paths cannot be selected; ambiguity is refused. Only Engineer principals and Engineer-bound workers receive the implementation write actions on the selected files. All unselected documentation remains Architect-owned, and existing test authority remains Inspector-owned. Every authority consumer must use the same validated, digest-bound specialization; stale, missing, altered or incompatible source/binding data refuses the affected grant before mutation. Without the explicit source and supported bound constitution, the existing core mapping remains unchanged. Article 10 continues to prohibit Architect code edits and Engineer specification edits; Engineer test edits remain limited to the existing focused-regression verb of Article 7, withheld in independent-assurance tasks. This specialization neither expands nor narrows that existing test authority.\n\n',
      '',
    );
  expect(result).toBe(historical);
  return result;
}
