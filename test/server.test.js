import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function request(port, { method = 'GET', path: p = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function runHook(port, source, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'hooks', 'emit.js'), source, '--chibiscope'], { env: { ...process.env, CHIBISCOPE_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('server ingests hooks, dedupes, streams, and guards its host', async (t) => {
  const port = 47000 + Math.floor(Math.random() * 900);
  const srv = await startServer({ port, codex: false });
  t.after(() => srv.close());

  // SSE client
  const frames = [];
  const sse = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => frames.push(c));
      resolve(req);
    });
  });
  t.after(() => sse.destroy());

  const pre = { hook_event_name: 'PreToolUse', session_id: 'S', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'T1' };
  const hook = await runHook(port, 'claude', pre);
  assert.equal(hook.code, 0);
  assert.equal(hook.out, '');
  // same payload again (plugin + settings both installed) is dropped
  const dup = await request(port, { method: 'POST', path: '/ingest/claude', body: JSON.stringify(pre) });
  assert.match(dup.body, /"duplicate":true/);

  const cur = await runHook(port, 'cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'C', prompt: 'hi', workspace_roots: ['/w'] });
  assert.equal(cur.out, '{"continue":true}');
  // Cursor running Claude-format hooks from ~/.claude/settings.json is ignored
  const cross = await runHook(port, 'claude', { hook_event_name: 'PreToolUse', cursor_version: '3.21.16', conversation_id: 'C', tool_name: 'Read', tool_input: {} });
  assert.deepEqual(cross, { code: 0, out: '' });

  const state = JSON.parse((await request(port, { path: '/api/state' })).body);
  assert.deepEqual(state.events.map((e) => [e.source, e.type, e.cat]), [['claude', 'tool.start', 'test'], ['cursor', 'prompt', undefined]]);
  await new Promise((r) => setTimeout(r, 50));
  const stream = frames.join('');
  assert.match(stream, /event: snapshot/);
  assert.match(stream, /"tool.start"/);

  // DNS-rebinding / cross-site protection
  assert.equal((await request(port, { path: '/api/state', headers: { host: 'evil.example:' + port } })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/ingest/claude', body: '{}', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, { path: '/../package.json' })).status, 404);
  assert.equal((await request(port, { path: '/' })).status, 200);
});

test('hook bridge never fails when the server is down', async () => {
  const r = await runHook(1, 'cursor', { hook_event_name: 'stop', conversation_id: 'x', status: 'completed' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '{}');
  const bad = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'hooks', 'emit.js'), 'claude'], { env: { ...process.env, CHIBISCOPE_PORT: '1' } });
    child.on('close', (code) => resolve(code));
    child.stdin.end('not json');
  });
  assert.equal(bad, 0);
});

test('run.sh works with a GUI-style PATH and never fails', async () => {
  const run = (env, payload, source = 'cursor') => new Promise((resolve) => {
    const child = spawn('/bin/sh', [path.join(root, 'hooks', 'run.sh'), source, '--chibiscope'], { env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
  const prompt = { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', prompt: 'x' };
  const viaNode = await run({ PATH: '/usr/bin:/bin', HOME: process.env.HOME, CHIBISCOPE_NODE: process.execPath, CHIBISCOPE_PORT: '1' }, prompt);
  assert.deepEqual(viaNode, { code: 0, out: '{"continue":true}' });
  // No usable node on PATH: either a fallback location is found or the shell
  // answers by itself. Both must exit 0 with the reply Cursor expects.
  const bare = await run({ PATH: '/nonexistent', HOME: '/nonexistent', CHIBISCOPE_NODE: '/nonexistent/node', CHIBISCOPE_PORT: '1' }, prompt);
  assert.deepEqual(bare, { code: 0, out: '{"continue":true}' });
  const stop = await run({ PATH: '/nonexistent', HOME: '/nonexistent', CHIBISCOPE_NODE: '/nonexistent/node', CHIBISCOPE_PORT: '1' }, { hook_event_name: 'stop' });
  assert.deepEqual(stop, { code: 0, out: '{}' });
});
