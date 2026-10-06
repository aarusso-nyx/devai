// Writes the strict review-verdict projection the bridge hands to `codex exec
// --output-schema` (providerReplySchema, @devai-nyx/schemas; needs `pnpm run build`).
import { writeFileSync } from 'node:fs';
import { providerReplySchema } from '../../packages/schemas/dist/index.js';

const [target] = process.argv.slice(2);
if (target === undefined) {
  console.error('usage: gen-schema.mjs <file>');
  process.exit(2);
}
writeFileSync(target, JSON.stringify(providerReplySchema('review-verdict.schema.json', true)));
