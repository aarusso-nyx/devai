// Entire external boundary is deterministic. Actual publication CLI/control code
// still runs; no npm/build/tar/site generator or real network request is allowed.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const file = process.env.PAGES_FIXTURE_STATE;
const calls = process.env.PAGES_FIXTURE_CALLS;
const state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state));
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  childProcess[key] = () => {
    throw new Error('BUILD_OR_SUBPROCESS_FORBIDDEN');
  };
syncBuiltinESMExports();
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method ?? 'GET';
  appendFileSync(calls, `${JSON.stringify({ origin: url.origin, path: url.pathname, method })}\n`);
  if (url.origin === 'https://aarusso-nyx.github.io' && url.pathname === '/devai/index.html')
    return new Response(state.live ? 'retained site' : 'previous site');
  if (url.origin === 'https://test.actions.githubusercontent.com')
    return Response.json({ value: 'fixture-secret-oidc' });
  if (url.origin !== 'https://api.github.com') throw new Error('NETWORK_FORBIDDEN');
  const root = '/repos/aarusso-nyx/devai';
  if (method === 'GET' && url.pathname === `${root}/deployments`)
    return Response.json(state.deployments);
  if (method === 'GET' && url.pathname === `${root}/deployments/9/statuses`)
    return Response.json(state.statuses);
  if (method === 'GET' && url.pathname === `${root}/pages/deployments/pages-17`) {
    state.live = true;
    save();
    return Response.json({ status: 'succeed' });
  }
  const body = options.body ? JSON.parse(options.body) : {};
  if (method === 'POST' && url.pathname === `${root}/deployments`) {
    const deployment = { ...body, id: 9, sha: body.ref };
    state.deployments.push(deployment);
    save();
    return Response.json(deployment, { status: 201 });
  }
  if (method === 'POST' && url.pathname === `${root}/pages/deployments`) {
    state.submissions++;
    save();
    if (state.loseResponse) throw new Error('secret request body must not escape');
    return Response.json({ id: 'pages-17' }, { status: 200 });
  }
  if (method === 'POST' && url.pathname === `${root}/deployments/9/statuses`) {
    const status = {
      ...body,
      id: state.statuses.length + 1,
      deployment_url: `https://api.github.com${root}/deployments/9`,
    };
    state.statuses.push(status);
    save();
    return Response.json(status, { status: 201 });
  }
  throw new Error('NETWORK_FORBIDDEN');
};
