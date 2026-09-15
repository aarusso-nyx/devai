#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const destination = process.argv[2];
if (!destination) throw new Error('SETTINGS_OUTPUT_REQUIRED');
const result = spawnSync('gh', ['api', 'repos/aarusso-nyx/devai/branches/main/protection'], {
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error('SETTINGS_OBSERVATION_FAILED');
const current = JSON.parse(result.stdout);
const checks = (current.required_status_checks?.checks ?? []).filter(
  (check) =>
    check.context !== 'Validate candidate verifier without protected inputs' &&
    check.context !== 'devai-release-gate',
);
const appId = current.required_status_checks?.checks?.find(
  (check) => check.context === 'Validate candidate verifier without protected inputs',
)?.app_id;
checks.push({ context: 'devai-release-gate', ...(appId ? { app_id: appId } : {}) });
const reviews = { ...current.required_pull_request_reviews, required_approving_review_count: 0 };
delete reviews.url;
const proposed = {
  required_status_checks: { strict: true, checks },
  enforce_admins: current.enforce_admins.enabled,
  required_pull_request_reviews: reviews,
  restrictions:
    current.restrictions == null
      ? null
      : {
          users: current.restrictions.users.map((user) => user.login),
          teams: current.restrictions.teams.map((team) => team.slug),
          apps: current.restrictions.apps.map((app) => app.slug),
        },
};
for (const name of [
  'required_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'block_creations',
  'required_conversation_resolution',
  'lock_branch',
  'allow_fork_syncing',
]) {
  if (current[name] !== undefined) proposed[name] = current[name].enabled;
}
mkdirSync(destination, { recursive: false });
writeFileSync(join(destination, 'current.json'), `${JSON.stringify(current, null, 2)}\n`);
writeFileSync(join(destination, 'proposed.json'), `${JSON.stringify(proposed, null, 2)}\n`);
writeFileSync(
  join(destination, 'REVIEW.md'),
  '# Branch protection proposal\n\nNo settings were changed. First demonstrate devai-release-gate on the exact candidate. Re-read protection and compare current.json immediately before applying. Owner separately authorizes PUT /repos/aarusso-nyx/devai/branches/main/protection with proposed.json. Preserve the separate required-signatures setting. Read back and verify after the authorized update.\n',
);
process.stdout.write('Prepared settings proposal; no external changes.\n');
