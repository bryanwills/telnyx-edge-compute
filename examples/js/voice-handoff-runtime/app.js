'use strict';

/**
 * Local development wrapper for JavaScript edge functions.
 *
 * Simulates the faas-js-runtime used by the Telnyx edge compute platform:
 *   - Calls fn.init() once at startup
 *   - Builds a context object with method, headers, query, log
 *   - Auto-parses JSON request bodies (mirrors runtime behaviour)
 *   - Passes (context, body) to fn.handle() for each request
 *   - Returns { statusCode, headers, body } to the HTTP client
 *   - Calls fn.shutdown() on SIGTERM / SIGINT
 */

const http = require('http');
const { URL } = require('url');

const fn = require('.');

function buildLogger(req) {
  const ts = () => new Date().toISOString();
  const prefix = () => `[${ts()}] [${req.method} ${req.url}]`;
  return {
    info: (msg, data) => console.log(`${prefix()} INFO  ${msg}`, data != null ? JSON.stringify(data) : ''),
    warn: (msg, data) => console.warn(`${prefix()} WARN  ${msg}`, data != null ? JSON.stringify(data) : ''),
    error: (msg, data) => console.error(`${prefix()} ERROR ${msg}`, data != null ? JSON.stringify(data) : ''),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req);

  let body;
  const contentType = req.headers['content-type'] || '';
  if (raw.length > 0) {
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        body = raw.toString('utf-8');
      }
    } else {
      body = raw.toString('utf-8');
    }
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const context = {
    method: req.method,
    path: parsedUrl.pathname,
    headers: req.headers,
    query: Object.fromEntries(parsedUrl.searchParams),
    log: buildLogger(req),
    rawBody: raw,
  };

  try {
    const result = await fn.handle(context, body);

    const statusCode = result?.statusCode ?? 200;
    const extraHeaders = result?.headers ?? {};
    const responseBody = result?.body ?? result;

    let payload;
    if (Buffer.isBuffer(responseBody)) {
      payload = responseBody;
    } else if (typeof responseBody === 'string') {
      payload = responseBody;
    } else {
      payload = JSON.stringify(responseBody, null, 2);
    }

    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(payload);
  } catch (error) {
    console.error('Handler error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
  }
});

if (typeof fn.init === 'function') {
  try {
    fn.init();
  } catch (error) {
    console.error('init() failed:', error);
    process.exit(1);
  }
}

const port = parseInt(process.env.PORT || '8080', 10);
server.listen(port, () => console.log(`Function running on port ${port}`));

function shutdown() {
  if (typeof fn.shutdown === 'function') {
    try {
      fn.shutdown();
    } catch (error) {
      console.error('shutdown() error:', error);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
