// #321 Codex review probe: a local endpoint that records the request `codex exec` would
// send and answers it with HTTP 400, so no provider is reached and no token is spent.
//
// codex is pointed here with `-c openai_base_url="http://127.0.0.1:<port>/backend-api/codex"`,
// which changes only where the request goes. The server
//   - declines the Responses-over-WebSocket upgrade with 426, which makes codex (0.157.1)
//     fall back to HTTP POST on the same turn (core/src/client.rs, FallbackToHttp);
//   - forwards `GET .../models` upstream (no tokens) so the request is built from the live
//     server catalog, unless PROBE_LOCAL_CATALOG=1;
//   - records every request with sensitive headers removed and the JSON body decoded.
//
// Usage: node capture-server.mjs <out-dir>
// Writes <out-dir>/port once listening, requests.jsonl and tools.json.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';

const [out] = process.argv.slice(2);
if (out === undefined) {
  console.error('usage: capture-server.mjs <out-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const SENSITIVE =
  /^(authorization|cookie|set-cookie|chatgpt-account-id|openai-organization|openai-project|x-api-key|proxy-authorization|.*token.*|.*session.*)$/iu;

/** A credential's kind only, never its value. */
function credentialKind(value) {
  const token = String(value ?? '').replace(/^Bearer\s+/iu, '');
  if (token.length === 0) return 'absent';
  if (token.startsWith('sk-')) return 'api-key';
  if (token.startsWith('eyJ')) return 'jwt';
  return 'other';
}

function redactedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE.test(name)
        ? name.toLowerCase() === 'authorization'
          ? `[REDACTED ${credentialKind(value)}]`
          : '[REDACTED]'
        : value,
    ]),
  );
}

function decode(buffer, encoding) {
  switch (String(encoding ?? '').toLowerCase()) {
    case '':
    case 'identity':
      return buffer;
    case 'zstd':
      return zstdDecompressSync(buffer);
    case 'gzip':
      return gunzipSync(buffer);
    case 'br':
      return brotliDecompressSync(buffer);
    case 'deflate':
      return inflateSync(buffer);
    default:
      throw new Error(`unknown content-encoding ${String(encoding)}`);
  }
}

/** Remove credential-shaped strings before anything is written. */
function scrub(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/gu, '[REDACTED api-key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, '[REDACTED jwt]')
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/gu, 'Bearer [REDACTED]');
}

const log = (record) =>
  appendFileSync(join(out, 'requests.jsonl'), `${scrub(JSON.stringify(record))}\n`);

/** The real endpoint for a catalog read: ChatGPT backend for a JWT, the API for a key. */
function upstreamUrl(req) {
  return new URL(
    credentialKind(req.headers.authorization) === 'api-key'
      ? `https://api.openai.com/v1${String(req.url ?? '').replace(/^\/backend-api\/codex/u, '')}`
      : `https://chatgpt.com${String(req.url ?? '')}`,
  );
}

let modelRequests = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const isModelRequest = req.method === 'POST' && /\/responses(\?|$)/u.test(req.url ?? '');
    const isCatalog = req.method === 'GET' && /\/models(\?|$)/u.test(req.url ?? '');
    const record = {
      at: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: redactedHeaders(req.headers),
      body_bytes: raw.length,
      model_request: isModelRequest,
    };
    let body;
    try {
      const text = decode(raw, req.headers['content-encoding']).toString('utf8');
      body = text.length > 0 ? JSON.parse(text) : undefined;
      record.body = body;
    } catch (error) {
      record.body_error = String(error);
    }
    log(record);
    if (isModelRequest && body !== undefined) {
      modelRequests += 1;
      if (modelRequests === 1) {
        writeFileSync(
          join(out, 'tools.json'),
          `${JSON.stringify(
            {
              model: body.model,
              tool_choice: body.tool_choice,
              // Plain Responses requests carry `tools`; responses-lite requests (gpt-6-sol)
              // carry them in an `additional_tools` input item instead.
              tools: body.tools ?? null,
              additional_tools: (body.input ?? []).filter(
                (item) => item.type === 'additional_tools',
              ),
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    if (isCatalog && process.env.PROBE_LOCAL_CATALOG !== '1') {
      const upstream = upstreamUrl(req);
      const forward = httpsRequest(
        upstream,
        { method: 'GET', headers: { ...req.headers, host: upstream.host } },
        (upstreamRes) => {
          log({
            at: new Date().toISOString(),
            catalog_forwarded: true,
            status: upstreamRes.statusCode,
          });
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      forward.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      forward.end();
      return;
    }
    res.writeHead(isModelRequest ? 400 : 404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'devai codex review probe: request recorded, not forwarded',
          type: 'invalid_request_error',
          code: 'devai_probe_capture',
        },
      }),
    );
  });
});

// Responses over WebSocket: decline, so codex falls back to HTTP POST on the same turn.
server.on('upgrade', (req, socket) => {
  log({ at: new Date().toISOString(), method: 'UPGRADE', path: req.url, answered: 426 });
  socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(out, 'port'), String(server.address().port));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
