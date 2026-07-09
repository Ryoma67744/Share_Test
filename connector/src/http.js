#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, assertConfigured } from './config.js';
import * as tools from './tools.js';

// =============================================================================
// DESI Data Share — READ-ONLY HTTP connector (for ChatGPT Custom GPT Actions).
// Same read-only core as the MCP server (tools.js), exposed over HTTP + OpenAPI
// and protected by an API key. GET-only; no write path exists. Never holds the
// master password, so the server rejects any structural write regardless.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(here, '..', 'openapi.json');
const HTTP_MATRIX_DEFAULT_CAP = 10000; // conservative inline cap for Action responses

function send(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function authorized(req) {
  if (!config.apiKey) return false; // an API key MUST be configured
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const key = m ? m[1] : (req.headers['x-api-key'] || '');
  return !!key && key === config.apiKey;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    // --- unauthenticated setup/health endpoints ---
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, publicOnly: config.publicOnly });
    if (req.method === 'GET' && path === '/openapi.json') {
      if (existsSync(OPENAPI_PATH)) return send(res, 200, readFileSync(OPENAPI_PATH, 'utf8'));
      return send(res, 404, { error: 'openapi.json not found' });
    }

    // --- everything else requires the API key ---
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized: missing or invalid API key' });
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed (this connector is read-only)' });

    let m;
    if (path === '/projects') {
      return send(res, 200, await tools.listProjects());
    }
    if ((m = /^\/projects\/([^/]+)$/.exec(path))) {
      return send(res, 200, await tools.getProject(decodeURIComponent(m[1])));
    }
    if ((m = /^\/projects\/([^/]+)\/compounds$/.exec(path))) {
      return send(res, 200, await tools.listCompounds(decodeURIComponent(m[1])));
    }
    if ((m = /^\/projects\/([^/]+)\/roi-stats$/.exec(path))) {
      return send(res, 200, await tools.getRoiStats(decodeURIComponent(m[1]), {
        section: q.get('section') || undefined,
        roi: q.get('roi') || undefined,
        compound: q.get('compound') || undefined,
      }));
    }
    if ((m = /^\/projects\/([^/]+)\/matrix$/.exec(path))) {
      return send(res, 200, await tools.getMatrix(decodeURIComponent(m[1]), {
        compound: q.get('compound') || undefined,
        section: q.get('section') || undefined,
        roi: q.get('roi') || undefined,
        // Conservative default cap for HTTP so Action responses stay small.
        max_rows: q.get('max_rows') != null ? Number(q.get('max_rows')) : HTTP_MATRIX_DEFAULT_CAP,
        downsample: q.get('downsample') != null ? Number(q.get('downsample')) : undefined,
        // `to_file` is intentionally NOT exposed over HTTP: the host filesystem
        // is not reachable by the AI. For very large raw data, use the local
        // connector + CSV upload instead (see README "道A").
      }));
    }
    // --- Registered MRM library (read-only) ---
    if (path === '/mrm') {
      return send(res, 200, await tools.searchMrm({
        q: q.get('q') || undefined,
        tag: q.get('tag') || undefined,
        polarity: q.get('polarity') || undefined,
      }));
    }
    // --- Assemble a MassLynx .exp from registered MRMs (repeat ?name=...) ---
    if (path === '/exp') {
      return send(res, 200, await tools.buildExpForNames({ names: q.getAll('name') }));
    }
    return send(res, 404, { error: 'not found: ' + path });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

function main() {
  assertConfigured();
  if (!config.apiKey) {
    console.error('FATAL: CONNECTOR_API_KEY must be set — the HTTP endpoint must be protected. See .env.example.');
    process.exit(1);
  }
  if (!config.publicOnly) {
    console.error('WARNING: PUBLIC_ONLY is off — private projects are readable when their passwords are configured. Make sure this endpoint is trusted and the API key stays secret.');
  }
  server.listen(config.port, () => {
    console.error('desi-share HTTP connector (read-only) listening on :' + config.port + ' (publicOnly=' + config.publicOnly + ')');
  });
}

main();
