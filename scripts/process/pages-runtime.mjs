// Shared host runtime for the Pages publication entry points: durable local
// record retention and the Actions OIDC token read. No subprocesses.
import { appendFileSync, fsyncSync } from 'node:fs';

export function retainRecord(descriptor, record) {
  appendFileSync(descriptor, `${JSON.stringify(record)}\n`);
  fsyncSync(descriptor);
}

export async function getOidcToken(env = process.env) {
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (
    endpoint.protocol !== 'https:' ||
    !endpoint.hostname.endsWith('.actions.githubusercontent.com') ||
    endpoint.username ||
    endpoint.password ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error('PAGES_OIDC_CONTEXT');
  const response = await fetch(endpoint, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (response.status !== 200 || !response.body) throw new Error('PAGES_OIDC_UNAVAILABLE');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('PAGES_OIDC_UNAVAILABLE');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof result.value !== 'string' || !result.value) throw new Error('PAGES_OIDC_UNAVAILABLE');
  return result.value;
}
