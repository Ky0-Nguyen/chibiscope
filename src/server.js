// Local event bus + static UI host. Zero dependencies.
//
//   POST /ingest/claude | /ingest/cursor   raw hook payloads
//   POST /ingest/events                    already-normalized events (any agent)
//   GET  /events                           Server-Sent Events stream
//   GET  /api/state                        recent events snapshot
//   GET  /api/health                       { name: 'chibiscope', version }
//   POST /api/clear                        drop buffered events
//
// Binds to 127.0.0.1 and rejects foreign Host/Origin headers, so a web page
// you visit can neither read your prompts (DNS rebinding) nor inject or clear
// events. Programs running on this machine (curl, scripts) are not blocked:
// they could read your agents' transcripts from ~/.claude and ~/.codex anyway.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './normalize.js';
import { watchCodex } from './codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
export const VERSION = pkg.version;
export const DEFAULT_PORT = 4777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function createHub({ max = 3000 } = {}) {
  const events = [];
  const clients = new Set();
  let seq = 0;
  let pending = [];
  let timer = null;
  return {
    events,
    clients,
    push(list) {
      if (!list.length) return;
      for (const e of list) {
        e.id = ++seq;
        events.push(e);
      }
      if (events.length > max) events.splice(0, events.length - max);
      const frame = list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      for (const res of clients) res.write(frame);
    },
    /**
     * Async hooks run in parallel, so a fast tool's PostToolUse can arrive
     * before its PreToolUse. Hold hook events briefly and release them in hook
     * time order, with each call's start ahead of its end.
     */
    pushSoon(list, delay = 150) {
      pending.push(...list);
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = pending;
        pending = [];
        this.push(orderBatch(batch));
      }, delay);
    },
    clear() {
      events.length = 0;
      pending = [];
      for (const res of clients) res.write(`event: clear\ndata: {}\n\n`);
    },
  };
}

export function orderBatch(batch) {
  const key = (e) => `${e.session}|${e.call}`;
  const ends = new Map();
  for (const e of batch) if (e.type === 'tool.end' && e.call) ends.set(key(e), e.ts || 0);
  const sortTs = (e) => {
    const t = e.ts || 0;
    // a start never sorts after its own end, even if its hook process started later
    if (e.type === 'tool.start' && e.call && ends.has(key(e))) return Math.min(t, ends.get(key(e)) - 0.5);
    return t;
  };
  return batch.map((e, i) => ({ e, i, t: sortTs(e) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

function readBody(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!ok.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true; // hooks, curl, file://, sandboxed webviews
  try {
    const u = new URL(origin);
    if (u.protocol === 'vscode-webview:') return true;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === port;
  } catch {
    return false;
  }
}

// The same hook can be registered twice (plugin + settings.json, or user +
// project hooks.json). Drop identical payloads that arrive within a short window.
export function createDeduper(windowMs = 1500) {
  const seen = new Map();
  return (p) => {
    if (!p || typeof p !== 'object') return false;
    const now = Date.now();
    const key = JSON.stringify([
      p.hook_event_name, p.session_id || p.conversation_id, p.tool_use_id, p.agent_id,
      typeof p.prompt === 'string' ? p.prompt.slice(0, 200) : null,
      typeof p.text === 'string' ? p.text.slice(0, 200) : null,
      p.file_path, p.command,
    ]);
    const prev = seen.get(key);
    seen.set(key, now);
    if (seen.size > 2000) for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
    return prev != null && now - prev < windowMs;
  };
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', codex = true, log = () => {} } = {}) {
  const hub = createHub();
  const isDuplicate = createDeduper();
  let codexWatcher = null;

  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req, port)) return send(res, 403, { error: 'forbidden host/origin' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    try {
      if (req.method === 'POST' && p.startsWith('/ingest/')) {
        const source = p.slice('/ingest/'.length).replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'agent';
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
        if (source !== 'events' && isDuplicate(payload)) return send(res, 200, { ok: true, accepted: 0, duplicate: true });
        const list = normalize(source === 'events' ? 'generic' : source, payload);
        hub.pushSoon(list);
        return send(res, 200, { ok: true, accepted: list.length });
      }

      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ version: VERSION, events: hub.events.slice(-800), codex: codexWatcher ? codexWatcher.root : null })}\n\n`);
        hub.clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(ping); hub.clients.delete(res); });
        return;
      }

      if (req.method === 'GET' && p === '/api/health') return send(res, 200, { name: 'chibiscope', version: VERSION, clients: hub.clients.size, events: hub.events.length, codex: !!codexWatcher });
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, { version: VERSION, events: hub.events });
      if (req.method === 'POST' && p === '/api/clear') { hub.clear(); return send(res, 200, { ok: true }); }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
        const file = path.resolve(WEB, rel);
        if (!file.startsWith(WEB + path.sep)) return send(res, 403, { error: 'nope' });
        fs.readFile(file, (err, data) => {
          if (err) return send(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      if (codex) {
        try {
          codexWatcher = watchCodex((list) => hub.push(list), { log });
          log(`codex: watching ${codexWatcher.root}`);
        } catch (e) {
          log(`codex: watcher disabled (${e.message})`);
        }
      }
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        hub,
        server,
        close: () => new Promise((r) => {
          codexWatcher?.stop();
          for (const c of hub.clients) c.end();
          server.close(() => r());
        }),
      });
    });
  });
}

/** Resolves to the health JSON if a ChibiScope server is already on `port`. */
export function probe(port = DEFAULT_PORT, timeout = 600) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        try { const j = JSON.parse(s); resolve(j.name === 'chibiscope' ? j : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
